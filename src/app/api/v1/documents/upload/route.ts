import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@clerk/nextjs/server';
import { prisma } from '@/lib/db';
import { supabaseAdmin } from '@/lib/supabase';
import { uploadToLocal } from '@/lib/local-storage';
import { nanoid } from 'nanoid';
import { fileUpload } from '@/lib/config/env';
import { ALLOWED_FILE_TYPES } from '@/lib/constants';
import { validateFile, getEffectiveMimeType, createCorrectedFile } from '@/lib/file-validation';
import { inngest } from '@/lib/inngest/client';

const ALLOWED_TYPES = [
  ...ALLOWED_FILE_TYPES,
  'image/jpg' // Additional type
];

export async function POST(request: NextRequest) {
  try {
    const { userId } = await auth();
    if (!userId) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    // Parse form data
    const formData = await request.formData();
    const file = formData.get('file') as File;
    const requestedOrganizationId = formData.get('organizationId') as string | null;
    const folderId = formData.get('folderId') as string | null;
    const tagsParam = formData.get('tags') as string | null;
    const documentTypeRaw = formData.get('documentType');
    const documentTypeParam = typeof documentTypeRaw === 'string' ? documentTypeRaw : null;
    
    // Parse tags if provided
    let tags: string[] = [];
    if (tagsParam) {
      try {
        tags = JSON.parse(tagsParam);
      } catch (error) {
        console.warn('Failed to parse tags:', error);
        tags = [];
      }
    }
    
    console.log('📥 Upload request parameters:', {
      fileName: file.name,
      fileSize: file.size,
      fileType: file.type,
      requestedOrganizationId,
      folderId,
      tags,
      documentType: documentTypeParam,
      userId
    });

    // Normalize optional metadata without rejecting upload
    const normalizedDocumentTypeParam = (documentTypeParam || '').trim() || null;

    if (!file) {
      return NextResponse.json({ error: 'No file uploaded' }, { status: 400 });
    }

    // Enhanced file validation with extension fallback
    console.log(`[API DEBUG] Upload attempt - File: ${file.name}, Type: "${file.type}", Size: ${file.size} bytes`);
    
    const fileValidation = validateFile(file, fileUpload.maxSize);
    
    if (!fileValidation.isValid) {
      console.error(`[API DEBUG] File validation failed: ${fileValidation.error}`);
      return NextResponse.json(
        { error: fileValidation.error || `Unsupported file: ${file.name}` },
        { status: 400 }
      );
    }

    // Use the effective MIME type (corrected if necessary)
    const effectiveMimeType = getEffectiveMimeType(fileValidation);
    console.log(`[API DEBUG] Using effective MIME type: "${effectiveMimeType}" for file: ${file.name}`);
    
    // Create corrected file if needed
    let processedFile = file;
    if (fileValidation.correctedMimeType) {
      processedFile = createCorrectedFile(file, fileValidation.correctedMimeType);
      console.log(`[API DEBUG] File MIME type corrected: "${file.type}" → "${fileValidation.correctedMimeType}"`);
    }

    // Verify user access to organization - use direct relationship with fallback creation
    let user = await prisma.user.findUnique({
      where: { clerkId: userId },
      select: { id: true, organizationId: true, email: true }
    });

    console.log('🔍 Upload authorization debug:', {
      clerkUserId: userId,
      requestOrgId: requestedOrganizationId,
      userFromDB: user ? { id: user.id, organizationId: user.organizationId, email: user.email } : null,
      userExists: !!user,
      userIdType: typeof user?.id
    });

    // If user doesn't exist in database, create them with default organization
    if (!user) {
      console.log('🔧 User not found in database, creating with default organization...');
      try {
        user = await prisma.user.create({
          data: {
            clerkId: userId,
            email: 'temp@example.com', // Will be updated by webhook later
            organizationId: 'default',
            role: 'MEMBER'
          },
          select: { id: true, organizationId: true, email: true }
        });
        console.log('✅ Created user with default organization:', user);
      } catch (error) {
        console.error('❌ Failed to create user:', error);
        return NextResponse.json(
          { error: 'Failed to create user account' },
          { status: 500 }
        );
      }
    }

    // Always use internal DB organization ID from authenticated user.
    // Client-provided organization IDs can be stale or from external identity providers.
    const organizationId = user.organizationId;

    if (requestedOrganizationId && requestedOrganizationId !== organizationId) {
      console.warn('⚠️ Upload request organizationId mismatch, using authenticated user organizationId instead:', {
        requestedOrganizationId,
        resolvedOrganizationId: organizationId,
        userId: user.id
      });
    }

    // Generate unique file ID and path with new structure
    const documentId = nanoid();
    const fileExtension = file.name.split('.').pop() || 'bin';
    const fileName = `${documentId}.${fileExtension}`;
    let filePath = `${organizationId}/docs/${fileName}`;

    // Upload to storage (Supabase if configured, otherwise local)
    let uploadData = null;
    let storageUrl: string;

    if (supabaseAdmin) {
      // Use Supabase storage
      const fileBuffer = await file.arrayBuffer();
      const { data, error: uploadError } = await supabaseAdmin.storage
        .from('documents')
        .upload(filePath, fileBuffer, {
          contentType: file.type,
          upsert: false
        });

      if (uploadError) {
        console.error('Supabase upload error details:', {
          message: uploadError.message,
          error: uploadError.error,
          statusCode: uploadError.statusCode,
          cause: uploadError.cause
        });
        return NextResponse.json(
          {
            error: 'Failed to upload file to storage',
            details: uploadError.message,
            supabaseError: uploadError.error
          },
          { status: 500 }
        );
      }
      uploadData = data;

      // Update filePath with the actual path returned by Supabase
      filePath = data.path;

      // Get public URL from Supabase
      const { data: { publicUrl } } = supabaseAdmin.storage
        .from('documents')
        .getPublicUrl(filePath);
      storageUrl = publicUrl;
    } else {
      // Fallback to local storage for development
      console.log('📁 Using local file storage (Supabase not configured)');
      const localResult = await uploadToLocal(processedFile, organizationId);

      if (!localResult.success) {
        console.error('Local storage upload error:', localResult.error);
        return NextResponse.json(
          {
            error: 'Failed to upload file to local storage',
            details: localResult.error
          },
          { status: 500 }
        );
      }

      filePath = localResult.path || filePath;
      storageUrl = localResult.url || `/uploads/${fileName}`;
      console.log('✅ File uploaded to local storage:', storageUrl);
    }

    // Validate and prepare document type
    const validDocumentTypes = ['PROPOSAL', 'CONTRACT', 'CERTIFICATION', 'COMPLIANCE', 'TEMPLATE', 'OTHER', 'SOLICITATION', 'AMENDMENT', 'CAPABILITY_STATEMENT', 'PAST_PERFORMANCE'];
    const validDocumentType = normalizedDocumentTypeParam && validDocumentTypes.includes(normalizedDocumentTypeParam) ? normalizedDocumentTypeParam : 'OTHER';
    
    // Validate folderId if provided
    const validFolderId = folderId === 'null' || folderId === '' ? null : folderId;
    if (validFolderId) {
      try {
        const folderExists = await prisma.folder.findFirst({
          where: {
            id: validFolderId,
            organizationId: organizationId
          }
        });
        if (!folderExists) {
          console.warn(`⚠️ Folder ${validFolderId} not found, using root folder instead`);
        }
      } catch (error) {
        console.warn('⚠️ Error validating folder, using root folder:', error);
      }
    }

    // Save document metadata to database with the Supabase path - following same pattern as update route
    console.log('💾 Creating document in database with data:', {
      id: documentId,
      organizationId,
      uploadedById: user.id,
      uploadedByUserId: userId, // For comparison
      userFromDb: user,
      folderId: validFolderId,
      name: file.name,
      size: file.size,
      filePath,
      mimeType: file.type,
      status: 'PENDING',
      tags,
      documentType: validDocumentType
    });
    
    try {
      const document = await prisma.document.create({
        data: {
          id: documentId,
          organizationId,
          uploadedById: user.id,
          folderId: validFolderId, // Use validated folder ID
          
          // Direct field mappings (no metadata field)
          name: file.name,
          uploadDate: new Date(),
          lastModified: new Date(),
          size: file.size,
          filePath, // Storage path from Supabase
          mimeType: effectiveMimeType,
          tags: tags || [], // Ensure tags is always an array
          documentType: validDocumentType, // Use validated document type without 'as any'
          
          // Initialize processing status in JSON field
          processing: {
            status: 'PENDING',
            startedAt: null,
            completedAt: null,
            error: null
          },
          
          // Initialize other required JSON fields with empty objects
          content: {},
          embeddings: {},
          entities: {},
          sharing: {},
          revisions: {},
          analysis: {}
        }
      });
      
      console.log('✅ Document created successfully:', document.id);

      // Trigger immediate basic processing (text extraction + sections only, no AI analysis)
      console.log('🤖 Starting immediate basic processing for document:', documentId);
      
      try {
        // Import document processor
        const { documentProcessor } = require('@/lib/ai/document-processor');
        
        // Process document with basic processing only (text extraction + sections)
        const processingResult = await documentProcessor.processDocumentBasic(
          documentId,
          (step: string, progress: number) => {
            console.log(`📊 Basic Processing [${documentId}]: ${step} - ${progress}%`);
          }
        );
        
        if (processingResult.success) {
          console.log('✅ Basic processing completed successfully for document:', documentId);
        } else {
          console.error('❌ Basic processing failed:', processingResult.error);
          // Update document status to failed
          await prisma.document.update({
            where: { id: documentId },
            data: { 
              processing: {
                status: 'FAILED',
                error: processingResult.error || 'Processing failed',
                completedAt: new Date()
              }
            }
          });
        }
      } catch (error) {
        console.error('❌ Failed to process document with basic processing:', error);
        // Update document status to failed
        await prisma.document.update({
          where: { id: documentId },
          data: { 
            processing: {
              status: 'FAILED',
              error: error instanceof Error ? error.message : 'Unknown error',
              completedAt: new Date()
            }
          }
        });
      }

      // Get signed URL for access (if Supabase configured)
      let urlData = null;
      if (supabaseAdmin) {
        const { data } = await supabaseAdmin.storage
          .from('documents')
          .createSignedUrl(filePath, 3600); // 1 hour expiry
        urlData = data;
      }

      return NextResponse.json({
        id: document.id,
        name: document.name,
        size: document.size,
        type: effectiveMimeType,
        uploadedAt: document.createdAt,
        status: (document.processing as any)?.status || 'PENDING',
        url: urlData?.signedUrl,
        message: 'Document uploaded and basic processing completed successfully.',
        processingStatus: 'BASIC_COMPLETED'
      });
      
    } catch (dbError) {
      console.error('❌ Database error creating document:', dbError);
      console.error('❌ Database error details:', {
        message: dbError.message,
        code: dbError.code,
        meta: dbError.meta,
        stack: dbError.stack
      });

      // Provide more specific error messages based on error type
      let errorMessage = 'Failed to save document to database';
      let errorDetails = dbError.message;

      if (dbError.code === 'P2002') {
        errorMessage = 'Document with this ID already exists';
        errorDetails = 'Please try uploading again';
      } else if (dbError.code === 'P2003') {
        errorMessage = 'Invalid reference to organization or folder';
        errorDetails = 'Please refresh the page and try again';
      } else if (dbError.code === 'P2025') {
        errorMessage = 'Referenced organization or folder not found';
        errorDetails = 'Please refresh the page and try again';
      } else if (dbError.message?.includes('violates check constraint')) {
        errorMessage = 'Invalid document type or other field value';
        errorDetails = 'Please check your input and try again';
      }

      return NextResponse.json(
        { 
          error: errorMessage,
          details: errorDetails,
          code: dbError.code || 'UNKNOWN'
        },
        { status: 500 }
      );
    }

  } catch (error) {
    console.error('Document upload error:', error);
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    );
  }
}

export async function GET(request: NextRequest) {
  try {
    const { userId } = await auth();
    if (!userId) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const { searchParams } = new URL(request.url);
    const organizationId = searchParams.get('organizationId');

    if (!organizationId) {
      return NextResponse.json(
        { error: 'Organization ID required' },
        { status: 400 }
      );
    }

    // Verify user access to organization - use direct relationship with fallback creation
    let user = await prisma.user.findUnique({
      where: { clerkId: userId },
      select: { id: true, organizationId: true, email: true }
    });

    console.log('🔍 Upload authorization debug:', {
      clerkUserId: userId,
      requestOrgId: organizationId,
      userFromDB: user ? { id: user.id, organizationId: user.organizationId } : null
    });

    // If user doesn't exist in database, create them with default organization
    if (!user) {
      console.log('🔧 User not found in database, creating with default organization...');
      try {
        user = await prisma.user.create({
          data: {
            clerkId: userId,
            email: 'temp@example.com', // Will be updated by webhook later
            organizationId: 'default',
            role: 'MEMBER'
          },
          select: { id: true, organizationId: true, email: true }
        });
        console.log('✅ Created user with default organization:', user);
      } catch (error) {
        console.error('❌ Failed to create user:', error);
        return NextResponse.json(
          { error: 'Failed to create user account' },
          { status: 500 }
        );
      }
    }

    // Allow access to default organization or user's assigned organization
    const hasAccess = user.organizationId === organizationId || 
                     (organizationId === 'default' && user.organizationId);

    if (!hasAccess) {
      console.error('❌ Organization access denied:', {
        userOrgId: user.organizationId,
        requestOrgId: organizationId,
        isDefault: organizationId === 'default'
      });
      return NextResponse.json(
        { 
          error: 'Access denied to organization',
          details: `User belongs to organization '${user.organizationId}' but trying to access '${organizationId}'`
        },
        { status: 403 }
      );
    }

    // Get user's documents in this organization
    const documents = await prisma.document.findMany({
      where: {
        organizationId,
        uploadedById: user.id // Use internal user ID, not Clerk ID
      },
      orderBy: {
        createdAt: 'desc'
      },
      select: {
        id: true,
        name: true,
        size: true,
        mimeType: true,
        processing: true,
        createdAt: true,
        updatedAt: true,
        extractedText: true
      }
    });

    return NextResponse.json({
      documents: documents.map(doc => ({
        id: doc.id,
        name: doc.name,          // Direct field alignment
        size: doc.size,          // Direct field alignment  
        type: doc.mimeType,
        status: (doc.processing as any)?.status || 'PENDING',  // Get status from processing JSON
        uploadedAt: doc.createdAt,
        processedAt: (doc.processing as any)?.completedAt || null,
        hasContent: !!doc.extractedText
      }))
    });

  } catch (error) {
    console.error('Documents list error:', error);
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    );
  }
}
