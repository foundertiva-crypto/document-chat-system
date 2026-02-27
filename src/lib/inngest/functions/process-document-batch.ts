import { inngest } from '../client'
import { prisma } from '@/lib/prisma'

type BatchProgressUpdate = {
  batchId: string
  organizationId: string
  documentId: string
  failed: boolean
}

const MAX_BATCH_PROGRESS_UPDATE_RETRIES = 5

const updateBatchProgressForDocument = async ({ batchId, organizationId, documentId, failed }: BatchProgressUpdate) => {
  for (let attempt = 0; attempt < MAX_BATCH_PROGRESS_UPDATE_RETRIES; attempt++) {
    const batch = await prisma.batchProcessing.findFirst({
      where: {
        id: batchId,
        organizationId,
      },
    })

    if (!batch) {
      return { found: false as const }
    }

    const metadata = (batch.metadata as any) || {}
    const queueingSummary = metadata.queueingSummary || {}
    const tracker = metadata.tracker || {}

    const expectedDocumentIds: string[] = Array.from(
      new Set(
        (tracker.expectedDocumentIds as string[]) || [
          ...(queueingSummary.queuedBasicDocumentIds || []),
          ...(queueingSummary.queuedVectorizeDocumentIds || []),
        ]
      )
    )

    const terminalDocumentIds = new Set<string>((tracker.terminalDocumentIds as string[]) || [])
    const failedDocumentIds = new Set<string>((tracker.failedDocumentIds as string[]) || [])

    if (terminalDocumentIds.has(documentId)) {
      return {
        found: true as const,
        alreadyTerminal: true as const,
        isDone: batch.status === 'completed' || batch.status === 'failed',
      }
    }

    terminalDocumentIds.add(documentId)
    if (failed) {
      failedDocumentIds.add(documentId)
    }

    const pendingDocumentIds = expectedDocumentIds.filter((id) => !terminalDocumentIds.has(id))
    const processedDocuments = terminalDocumentIds.size - failedDocumentIds.size
    const failedDocuments = failedDocumentIds.size
    const isDone = expectedDocumentIds.length === 0 || pendingDocumentIds.length === 0
    const status = isDone ? (failedDocuments > 0 ? 'failed' : 'completed') : 'processing'

    const updatedMetadata = {
      ...metadata,
      tracker: {
        expectedDocumentIds,
        terminalDocumentIds: Array.from(terminalDocumentIds),
        failedDocumentIds: Array.from(failedDocumentIds),
        pendingDocumentIds,
      },
      ...(isDone
        ? {
            completionSummary: {
              expectedDocuments: expectedDocumentIds.length,
              processedDocuments,
              failedDocuments,
              completedAt: new Date().toISOString(),
            },
          }
        : {}),
    }

    const updateResult = await prisma.batchProcessing.updateMany({
      where: {
        id: batchId,
        organizationId,
        updatedAt: batch.updatedAt,
      },
      data: {
        status,
        processedDocuments,
        failedDocuments,
        completedAt: isDone ? new Date() : null,
        error: isDone && failedDocuments > 0 ? `${failedDocuments} document(s) failed during batch processing` : null,
        metadata: updatedMetadata as any,
      },
    })

    if (updateResult.count === 1) {
      return {
        found: true as const,
        alreadyTerminal: false as const,
        isDone,
        status,
        processedDocuments,
        failedDocuments,
        startedAt: batch.startedAt,
      }
    }
  }

  throw new Error(`Failed to update batch progress for ${batchId} after ${MAX_BATCH_PROGRESS_UPDATE_RETRIES} retries`)
}

export const processDocumentBatch = inngest.createFunction(
  {
    id: 'process-document-batch',
    name: 'Process Document Batch',
    retries: 2,
    concurrency: {
      limit: 2,
    },
  },
  { event: 'document/batch.process' },
  async ({ event, step }) => {
    const { batchId, documentIds, organizationId, userId, options = {} } = event.data
    const autoVectorize = options?.autoVectorize !== false
    const forceReprocess = options?.forceReprocess === true

    await step.run('mark-batch-processing', async () => {
      await prisma.batchProcessing.update({
        where: { id: batchId },
        data: {
          status: 'processing',
          startedAt: new Date(),
          metadata: {
            ...(options || {}),
            autoVectorize,
            forceReprocess,
          } as any,
        },
      })
    })

    const results = await step.run('analyze-document-jobs', async () => {
      const documents = await prisma.document.findMany({
        where: {
          id: { in: documentIds },
          organizationId,
          deletedAt: null,
        },
        select: {
          id: true,
          extractedText: true,
          embeddings: true,
          processing: true,
        },
      })

      const skipped: string[] = []
      const queuedBasic: string[] = []
      const queuedVectorize: string[] = []
      const autoVectorizeAfterBasic: string[] = []

      for (const document of documents) {
        const processing = (document.processing as any) || {}
        const embeddings = (document.embeddings as any) || {}
        const hasEmbeddings = Array.isArray(embeddings?.chunks) && embeddings.chunks.length > 0
        const statusIndexed = ['INDEXED', 'COMPLETED'].includes(processing?.currentStatus)
        const hasExtractedText = !!document.extractedText?.trim()

        if (hasEmbeddings && statusIndexed && !forceReprocess) {
          skipped.push(document.id)
          continue
        }

        const needsBasicProcessing = !hasExtractedText || forceReprocess

        if (needsBasicProcessing) {
          queuedBasic.push(document.id)

          if (autoVectorize) {
            autoVectorizeAfterBasic.push(document.id)
          }
          continue
        }

        if (autoVectorize) {
          queuedVectorize.push(document.id)
        }
      }

      return {
        foundDocuments: documents.length,
        skipped,
        queuedBasic,
        queuedVectorize,
        autoVectorizeAfterBasic,
      }
    })

    const expectedDocumentIds = Array.from(new Set([...results.queuedVectorize, ...results.queuedBasic]))
    const isImmediateCompletion = expectedDocumentIds.length === 0

    await step.run('save-batch-queueing-summary', async () => {
      await prisma.batchProcessing.update({
        where: { id: batchId },
        data: {
          status: isImmediateCompletion ? 'completed' : 'processing',
          completedAt: isImmediateCompletion ? new Date() : null,
          processedDocuments: 0,
          failedDocuments: 0,
          error: null,
          metadata: {
            ...(options || {}),
            autoVectorize,
            forceReprocess,
            tracker: {
              expectedDocumentIds,
              terminalDocumentIds: [],
              failedDocumentIds: [],
              pendingDocumentIds: expectedDocumentIds,
            },
            ...(isImmediateCompletion
              ? {
                  completionSummary: {
                    expectedDocuments: 0,
                    processedDocuments: 0,
                    failedDocuments: 0,
                    completedAt: new Date().toISOString(),
                  },
                }
              : {}),
            queueingSummary: {
              foundDocuments: results.foundDocuments,
              skippedDocuments: results.skipped.length,
              queuedBasicDocuments: results.queuedBasic.length,
              queuedVectorizeDocuments: results.queuedVectorize.length,
              autoVectorizeAfterBasicDocuments: results.autoVectorizeAfterBasic.length,
              skippedDocumentIds: results.skipped,
              queuedBasicDocumentIds: results.queuedBasic,
              queuedVectorizeDocumentIds: results.queuedVectorize,
              autoVectorizeAfterBasicDocumentIds: results.autoVectorizeAfterBasic,
            },
          } as any,
        },
      })
    })

    if (!isImmediateCompletion) {
      await step.run('fanout-document-jobs', async () => {
        for (const queuedBasicDocumentId of results.queuedBasic) {
          await inngest.send({
            name: 'document/process-basic.requested',
            data: {
              documentId: queuedBasicDocumentId,
              organizationId,
              userId,
              options: {
                source: 'batch-ingest',
                batchId,
                forceReprocess,
                autoVectorizeAfterBasic: autoVectorize,
                chunkSize: options?.chunkSize,
                overlap: options?.overlap,
              },
            },
          })
        }

        for (const queuedVectorizeDocumentId of results.queuedVectorize) {
          await inngest.send({
            name: 'document/vectorize.requested',
            data: {
              documentId: queuedVectorizeDocumentId,
              organizationId,
              userId,
              jobId: `batch_vectorize_${queuedVectorizeDocumentId}_${Date.now()}`,
              options: {
                batchId,
                forceReprocess,
                chunkSize: options?.chunkSize,
                overlap: options?.overlap,
              },
            },
          })
        }
      })
    } else {
      await step.sendEvent('send-batch-completed-event', {
        name: 'document/batch.completed',
        data: {
          batchId,
          organizationId,
          processedCount: 0,
          failedCount: 0,
          totalTime: 0,
        },
      })
    }

    return {
      success: true,
      batchId,
      ...results,
    }
  }
)

export const handleBatchBasicCompleted = inngest.createFunction(
  {
    id: 'handle-batch-basic-completed',
    name: 'Handle Batch Basic Completion',
  },
  { event: 'document/process-basic.completed' },
  async ({ event, step }) => {
    const { documentId, organizationId, batchId, options = {} } = event.data as any
    if (!batchId) return { skipped: true, reason: 'No batch context' }

    if (options?.autoVectorizeAfterBasic) {
      await step.sendEvent('queue-vectorization-after-basic', {
        name: 'document/vectorize.requested',
        data: {
          documentId,
          organizationId,
          userId: options?.userId,
          jobId: `batch_vectorize_${documentId}_${Date.now()}`,
          options: {
            batchId,
            forceReprocess: options?.forceReprocess,
            chunkSize: options?.chunkSize,
            overlap: options?.overlap,
          },
        },
      })

      return { success: true, action: 'queued-vectorization', documentId, batchId }
    }

    const update = await step.run('mark-basic-complete-in-batch', async () => {
      return updateBatchProgressForDocument({
        batchId,
        organizationId,
        documentId,
        failed: false,
      })
    })

    if (update.found && !update.alreadyTerminal && update.isDone) {
      await step.sendEvent('send-batch-terminal-event', {
        name: 'document/batch.completed',
        data: {
          batchId,
          organizationId,
          processedCount: update.processedDocuments,
          failedCount: update.failedDocuments,
          totalTime: update.startedAt ? Date.now() - new Date(update.startedAt).getTime() : 0,
        },
      })
    }

    return { success: true, batchId, documentId }
  }
)

export const handleBatchBasicFailed = inngest.createFunction(
  {
    id: 'handle-batch-basic-failed',
    name: 'Handle Batch Basic Failure',
  },
  { event: 'document/process-basic.failed' },
  async ({ event, step }) => {
    const { documentId, organizationId, batchId } = event.data as any
    if (!batchId) return { skipped: true, reason: 'No batch context' }

    const update = await step.run('mark-basic-failed-in-batch', async () => {
      return updateBatchProgressForDocument({
        batchId,
        organizationId,
        documentId,
        failed: true,
      })
    })

    if (update.found && !update.alreadyTerminal && update.isDone) {
      if (update.failedDocuments > 0) {
        await step.sendEvent('send-batch-failed-event', {
          name: 'document/batch.failed',
          data: {
            batchId,
            organizationId,
            error: `${update.failedDocuments} document(s) failed during batch processing`,
          },
        })
      } else {
        await step.sendEvent('send-batch-completed-event', {
          name: 'document/batch.completed',
          data: {
            batchId,
            organizationId,
            processedCount: update.processedDocuments,
            failedCount: update.failedDocuments,
            totalTime: update.startedAt ? Date.now() - new Date(update.startedAt).getTime() : 0,
          },
        })
      }
    }

    return { success: true, batchId, documentId }
  }
)

export const handleBatchVectorizeCompleted = inngest.createFunction(
  {
    id: 'handle-batch-vectorize-completed',
    name: 'Handle Batch Vectorize Completion',
  },
  { event: 'document/vectorize.completed' },
  async ({ event, step }) => {
    const { documentId, organizationId, batchId } = event.data as any
    if (!batchId) return { skipped: true, reason: 'No batch context' }

    const update = await step.run('mark-vectorize-complete-in-batch', async () => {
      return updateBatchProgressForDocument({
        batchId,
        organizationId,
        documentId,
        failed: false,
      })
    })

    if (update.found && !update.alreadyTerminal && update.isDone) {
      if (update.failedDocuments > 0) {
        await step.sendEvent('send-batch-failed-event', {
          name: 'document/batch.failed',
          data: {
            batchId,
            organizationId,
            error: `${update.failedDocuments} document(s) failed during batch processing`,
          },
        })
      } else {
        await step.sendEvent('send-batch-completed-event', {
          name: 'document/batch.completed',
          data: {
            batchId,
            organizationId,
            processedCount: update.processedDocuments,
            failedCount: update.failedDocuments,
            totalTime: update.startedAt ? Date.now() - new Date(update.startedAt).getTime() : 0,
          },
        })
      }
    }

    return { success: true, batchId, documentId }
  }
)

export const handleBatchVectorizeFailed = inngest.createFunction(
  {
    id: 'handle-batch-vectorize-failed',
    name: 'Handle Batch Vectorize Failure',
  },
  { event: 'document/vectorize.failed' },
  async ({ event, step }) => {
    const { documentId, organizationId, batchId } = event.data as any
    if (!batchId) return { skipped: true, reason: 'No batch context' }

    const update = await step.run('mark-vectorize-failed-in-batch', async () => {
      return updateBatchProgressForDocument({
        batchId,
        organizationId,
        documentId,
        failed: true,
      })
    })

    if (update.found && !update.alreadyTerminal && update.isDone) {
      await step.sendEvent('send-batch-failed-event', {
        name: 'document/batch.failed',
        data: {
          batchId,
          organizationId,
          error: `${update.failedDocuments} document(s) failed during batch processing`,
        },
      })
    }

    return { success: true, batchId, documentId }
  }
)
