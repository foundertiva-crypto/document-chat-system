import { NextRequest, NextResponse } from 'next/server'
import { auth } from '@clerk/nextjs/server'
import { prisma } from '@/lib/prisma'

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ batchId: string }> }
) {
  try {
    const { userId } = await auth()
    if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    const { batchId } = await params

    const user = await prisma.user.findUnique({
      where: { clerkId: userId },
      select: { organizationId: true },
    })

    if (!user) return NextResponse.json({ error: 'User not found' }, { status: 404 })

    const batch = await prisma.batchProcessing.findFirst({
      where: {
        id: batchId,
        organizationId: user.organizationId,
      },
    })

    if (!batch) return NextResponse.json({ error: 'Batch not found' }, { status: 404 })

    const metadata = (batch.metadata as any) || {}
    const summary = metadata.queueingSummary || {}

    return NextResponse.json({
      id: batch.id,
      status: batch.status,
      totalDocuments: batch.totalDocuments,
      processedDocuments: batch.processedDocuments,
      failedDocuments: batch.failedDocuments,
      skippedDocuments: summary.skippedDocuments || metadata.skippedDocuments || 0,
      startedAt: batch.startedAt,
      completedAt: batch.completedAt,
      error: batch.error,
      metadata,
      summary: {
        foundDocuments: summary.foundDocuments || metadata.foundDocumentIds?.length || 0,
        skippedDocuments: summary.skippedDocuments || metadata.skippedDocuments || 0,
        queuedBasicDocuments: summary.queuedBasicDocuments || 0,
        queuedVectorizeDocuments: summary.queuedVectorizeDocuments || 0,
      },
      createdAt: batch.createdAt,
      updatedAt: batch.updatedAt,
    })
  } catch (error) {
    console.error('Batch status error:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
