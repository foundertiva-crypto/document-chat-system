import { NextRequest, NextResponse } from 'next/server'
import { auth } from '@clerk/nextjs/server'
import { z } from 'zod'
import { prisma } from '@/lib/prisma'
import { inngest } from '@/lib/inngest/client'

const BatchIngestSchema = z.object({
  documentIds: z.array(z.string()).min(1).max(500),
  folderId: z.string().optional().nullable(),
  options: z.object({
    autoVectorize: z.boolean().default(true),
    forceReprocess: z.boolean().default(false),
    chunkSize: z.number().min(100).max(2000).optional(),
    overlap: z.number().min(0).max(500).optional(),
    priority: z.enum(['low', 'normal', 'high']).default('normal'),
  }).optional(),
})

export async function POST(request: NextRequest) {
  try {
    const { userId } = await auth()
    if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    const body = await request.json().catch(() => ({}))
    const parsed = BatchIngestSchema.safeParse(body)
    if (!parsed.success) {
      return NextResponse.json({ error: 'Invalid request data', details: parsed.error.format() }, { status: 400 })
    }

    const { documentIds, options = {} } = parsed.data

    const user = await prisma.user.findUnique({
      where: { clerkId: userId },
      select: { id: true, organizationId: true },
    })

    if (!user) return NextResponse.json({ error: 'User not found' }, { status: 404 })

    const documents = await prisma.document.findMany({
      where: {
        id: { in: documentIds },
        organizationId: user.organizationId,
        deletedAt: null,
      },
      select: { id: true },
    })

    if (documents.length === 0) {
      return NextResponse.json({ error: 'No matching documents found for this organization' }, { status: 404 })
    }

    const foundDocumentIds = documents.map(d => d.id)
    const batchId = `batch_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`

    await prisma.batchProcessing.create({
      data: {
        id: batchId,
        organizationId: user.organizationId,
        userId: user.id,
        status: 'queued',
        totalDocuments: foundDocumentIds.length,
        processedDocuments: 0,
        failedDocuments: 0,
        metadata: {
          options,
          requestedDocumentIds: documentIds,
          foundDocumentIds,
          skippedDocuments: 0,
        } as any,
      },
    })

    await inngest.send({
      name: 'document/batch.process',
      data: {
        batchId,
        documentIds: foundDocumentIds,
        organizationId: user.organizationId,
        userId: user.id,
        options,
      },
    })

    return NextResponse.json({
      success: true,
      batchId,
      status: 'queued',
      totalDocuments: foundDocumentIds.length,
      message: 'Batch accepted and queued',
    }, { status: 202 })
  } catch (error) {
    console.error('Batch ingest error:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
