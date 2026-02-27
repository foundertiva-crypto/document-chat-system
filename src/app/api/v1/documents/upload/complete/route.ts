import { NextRequest, NextResponse } from 'next/server'
import { auth } from '@clerk/nextjs/server'
import { z } from 'zod'
import { prisma } from '@/lib/db'

const CompleteSchema = z.object({
  storagePath: z.string().min(1),
  fileName: z.string().min(1),
  fileType: z.string().min(1),
  fileSize: z.number().positive(),
  folderId: z.string().nullable().optional(),
  documentType: z.string().optional().nullable(),
  tags: z.array(z.string()).optional(),
})

const validDocumentTypes = ['PROPOSAL', 'CONTRACT', 'CERTIFICATION', 'COMPLIANCE', 'TEMPLATE', 'OTHER', 'SOLICITATION', 'AMENDMENT', 'CAPABILITY_STATEMENT', 'PAST_PERFORMANCE']

export async function POST(request: NextRequest) {
  try {
    const { userId } = await auth()
    if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    const body = await request.json().catch(() => ({}))
    const parsed = CompleteSchema.safeParse(body)
    if (!parsed.success) {
      return NextResponse.json({ error: 'Invalid request data', details: parsed.error.format() }, { status: 400 })
    }

    const user = await prisma.user.findUnique({
      where: { clerkId: userId },
      select: { id: true, organizationId: true },
    })

    if (!user) return NextResponse.json({ error: 'User not found' }, { status: 404 })

    const { storagePath, fileName, fileType, fileSize, folderId, documentType, tags = [] } = parsed.data

    if (!storagePath.startsWith(`${user.organizationId}/docs/`)) {
      return NextResponse.json({ error: 'Invalid storage path for organization' }, { status: 403 })
    }

    const validFolderId = folderId === 'null' || folderId === '' ? null : folderId
    if (validFolderId) {
      const folder = await prisma.folder.findFirst({ where: { id: validFolderId, organizationId: user.organizationId } })
      if (!folder) {
        return NextResponse.json({ error: 'Folder not found for organization' }, { status: 400 })
      }
    }

    const normalizedDocumentType = documentType && validDocumentTypes.includes(documentType) ? documentType : 'OTHER'

    const document = await prisma.document.create({
      data: {
        organizationId: user.organizationId,
        uploadedById: user.id,
        folderId: validFolderId,
        name: fileName,
        uploadDate: new Date(),
        lastModified: new Date(),
        size: fileSize,
        filePath: storagePath,
        mimeType: fileType,
        tags,
        documentType: normalizedDocumentType as any,
        processing: {
          status: 'PENDING',
          startedAt: null,
          completedAt: null,
          error: null,
        },
        content: {},
        embeddings: {},
        entities: {},
        sharing: {},
        revisions: {},
        analysis: {},
      },
    })

    try {
      const { documentProcessor } = require('@/lib/ai/document-processor')
      const processingResult = await documentProcessor.processDocumentBasic(document.id)
      if (!processingResult.success) {
        await prisma.document.update({
          where: { id: document.id },
          data: {
            processing: {
              status: 'FAILED',
              error: processingResult.error || 'Processing failed',
              completedAt: new Date(),
            },
          },
        })
      }
    } catch (error) {
      console.error('Failed to process direct-uploaded document:', error)
    }

    return NextResponse.json({
      success: true,
      id: document.id,
      name: document.name,
      size: document.size,
      type: document.mimeType,
      uploadedAt: document.createdAt,
      status: (document.processing as any)?.status || 'PENDING',
      message: 'Document uploaded successfully.',
      processingStatus: 'BASIC_COMPLETED',
    })
  } catch (error) {
    console.error('Upload complete error:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
