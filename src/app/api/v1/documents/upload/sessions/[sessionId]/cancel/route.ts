import { NextRequest, NextResponse } from 'next/server'
import { auth } from '@clerk/nextjs/server'
import { prisma } from '@/lib/prisma'
import { supabaseAdmin } from '@/lib/supabase'

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ sessionId: string }> }
) {
  try {
    const { userId } = await auth()
    if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    const { sessionId } = await params
    if (!sessionId) return NextResponse.json({ error: 'Missing sessionId' }, { status: 400 })

    const user = await prisma.user.findUnique({
      where: { clerkId: userId },
      select: { id: true, organizationId: true },
    })

    if (!user) return NextResponse.json({ error: 'User not found' }, { status: 404 })

    const documents = await prisma.document.findMany({
      where: {
        organizationId: user.organizationId,
        uploadedById: user.id,
      },
      select: {
        id: true,
        filePath: true,
        processing: true,
      },
    })

    const sessionDocuments = documents.filter((document) => {
      const processing = (document.processing as any) || {}
      return processing.uploadSessionId === sessionId
    })

    if (sessionDocuments.length === 0) {
      return NextResponse.json({ success: true, deletedDocuments: 0, storageDeleted: 0 })
    }

    let storageDeleted = 0
    if (supabaseAdmin) {
      for (const document of sessionDocuments) {
        if (!document.filePath) continue

        try {
          const { error } = await supabaseAdmin.storage.from('documents').remove([document.filePath])
          if (!error) storageDeleted += 1
        } catch (error) {
          console.warn('Failed to remove uploaded file while cancelling upload session', {
            documentId: document.id,
            filePath: document.filePath,
            error,
          })
        }
      }
    }

    const documentIds = sessionDocuments.map((document) => document.id)
    const deleteResult = await prisma.document.deleteMany({
      where: {
        id: { in: documentIds },
        organizationId: user.organizationId,
      },
    })

    return NextResponse.json({
      success: true,
      deletedDocuments: deleteResult.count,
      storageDeleted,
    })
  } catch (error) {
    console.error('Upload session cancellation error:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
