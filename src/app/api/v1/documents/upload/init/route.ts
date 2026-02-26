import { NextRequest, NextResponse } from 'next/server'
import { auth } from '@clerk/nextjs/server'
import { z } from 'zod'
import { nanoid } from 'nanoid'
import { prisma } from '@/lib/db'
import { supabaseAdmin } from '@/lib/supabase'

const InitSchema = z.object({
  fileName: z.string().min(1),
  fileType: z.string().min(1),
  fileSize: z.number().positive(),
  folderId: z.string().nullable().optional(),
  documentType: z.string().optional().nullable(),
  tags: z.array(z.string()).optional(),
})

export async function POST(request: NextRequest) {
  try {
    const { userId } = await auth()
    if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    if (!supabaseAdmin) {
      return NextResponse.json({ error: 'Supabase storage not configured' }, { status: 503 })
    }

    const body = await request.json().catch(() => ({}))
    const parsed = InitSchema.safeParse(body)
    if (!parsed.success) {
      return NextResponse.json({ error: 'Invalid request data', details: parsed.error.format() }, { status: 400 })
    }

    const user = await prisma.user.findUnique({
      where: { clerkId: userId },
      select: { id: true, organizationId: true },
    })

    if (!user) return NextResponse.json({ error: 'User not found' }, { status: 404 })

    const { fileName } = parsed.data
    const documentId = nanoid()
    const fileExtension = fileName.split('.').pop() || 'bin'
    const storagePath = `${user.organizationId}/docs/${documentId}.${fileExtension}`

    const { data, error } = await supabaseAdmin.storage
      .from('documents')
      .createSignedUploadUrl(storagePath)

    if (error || !data?.token) {
      return NextResponse.json(
        {
          error: 'Failed to create signed upload URL',
          details: error?.message || 'Unknown error',
        },
        { status: 500 }
      )
    }

    return NextResponse.json({
      success: true,
      upload: {
        token: data.token,
        path: storagePath,
      },
      resolved: {
        organizationId: user.organizationId,
        documentId,
      },
    })
  } catch (error) {
    console.error('Upload init error:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
