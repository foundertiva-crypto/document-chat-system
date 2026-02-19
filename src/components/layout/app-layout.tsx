'use client'

import { useState } from 'react'
import { usePathname } from 'next/navigation'
import { Header } from './header'
import { Sidebar } from './sidebar'
import { FloatingChat } from '@/components/chat/floating-chat'
import { DonationBanner } from '@/components/donation/donation-banner'

interface AppLayoutProps {
  children: React.ReactNode
  showNavigation?: boolean
}

export function AppLayout({ children, showNavigation = true }: AppLayoutProps) {
  const [sidebarOpen, setSidebarOpen] = useState(false)
  const [donationBannerVisible, setDonationBannerVisible] = useState(true)
  const pathname = usePathname()

  // Temporarily disable FloatingChat on documents page to test interference
  const shouldShowFloatingChat = showNavigation && !pathname.startsWith('/documents')

  if (!showNavigation) {
    return (
      <div className="min-h-screen bg-background">
        <main className="flex-1">
          <div className="container py-6">
            {children}
          </div>
        </main>
      </div>
    )
  }

  return (
    <div className="flex min-h-screen flex-col bg-background">
      {/* Donation Banner - At the very top */}
      <DonationBanner onVisibilityChange={setDonationBannerVisible} />

      {/* Main app container */}
      <div className="flex flex-1 min-h-0">
        {/* Sidebar */}
        <Sidebar
          isOpen={sidebarOpen}
          onClose={() => setSidebarOpen(false)}
          showNavigation={showNavigation}
        />

        {/* Main content */}
        <div className="flex min-h-0 min-w-0 flex-1 flex-col">
          {/* Header */}
          <Header
            onMobileMenuToggle={() => setSidebarOpen(!sidebarOpen)}
            showNavigation={showNavigation}
            donationBannerVisible={donationBannerVisible}
          />

          {/* Page content */}
          <main className="flex-1 overflow-y-auto">
            <div className="mx-auto w-full max-w-7xl px-4 py-4 md:px-6 md:py-6">
              {children}
            </div>
          </main>
        </div>
      </div>

      {/* Floating Chat - Temporarily disabled on documents page to test interference */}
      {shouldShowFloatingChat && <FloatingChat />}
    </div>
  )
}
