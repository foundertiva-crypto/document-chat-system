import { inngest } from '../client'
import { prisma } from '@/lib/prisma'

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

    const results = await step.run('fanout-document-jobs', async () => {
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

        if (!hasExtractedText || forceReprocess) {
          await inngest.send({
            name: 'document/process-basic.requested',
            data: {
              documentId: document.id,
              organizationId,
              userId,
              options: {
                source: 'batch-ingest',
                batchId,
                forceReprocess,
              },
            },
          })
          queuedBasic.push(document.id)
        }

        if (autoVectorize) {
          await inngest.send({
            name: 'document/vectorize.requested',
            data: {
              documentId: document.id,
              organizationId,
              userId,
              jobId: `batch_vectorize_${document.id}_${Date.now()}`,
              options: {
                forceReprocess,
                chunkSize: options?.chunkSize,
                overlap: options?.overlap,
              },
            },
          })
          queuedVectorize.push(document.id)
        }
      }

      return {
        foundDocuments: documents.length,
        skipped,
        queuedBasic,
        queuedVectorize,
      }
    })

    await step.run('complete-batch-queueing', async () => {
      await prisma.batchProcessing.update({
        where: { id: batchId },
        data: {
          status: 'completed',
          completedAt: new Date(),
          processedDocuments: results.queuedVectorize.length + results.queuedBasic.length,
          failedDocuments: 0,
          metadata: {
            ...(options || {}),
            autoVectorize,
            forceReprocess,
            queueingSummary: {
              foundDocuments: results.foundDocuments,
              skippedDocuments: results.skipped.length,
              queuedBasicDocuments: results.queuedBasic.length,
              queuedVectorizeDocuments: results.queuedVectorize.length,
              skippedDocumentIds: results.skipped,
              queuedBasicDocumentIds: results.queuedBasic,
              queuedVectorizeDocumentIds: results.queuedVectorize,
            },
          } as any,
        },
      })
    })

    await step.sendEvent('send-batch-completed-event', {
      name: 'document/batch.completed',
      data: {
        batchId,
        organizationId,
        processedCount: results.queuedVectorize.length + results.queuedBasic.length,
        failedCount: 0,
        totalTime: 0,
      },
    })

    return {
      success: true,
      batchId,
      ...results,
    }
  }
)
