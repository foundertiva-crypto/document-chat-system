'use client'

import React from 'react'
import { UserButton, useAuth } from '@clerk/nextjs'
import { Button } from '@/components/ui/button'
import { ThemeToggle } from '@/components/ui/theme-toggle'
import { HeaderSearch } from './header-search'
import { NotificationBadge } from '@/components/ui/notification-badge'
import { Menu } from 'lucide-react'

interface HeaderProps {
  onMobileMenuToggle?: () => void
  showNavigation?: boolean
  donationBannerVisible?: boolean
}

export function Header({ onMobileMenuToggle, showNavigation = true, donationBannerVisible = true }: HeaderProps) {
  const { isSignedIn } = useAuth()
  const [mounted, setMounted] = React.useState(false)

  React.useEffect(() => {
    setMounted(true)
  }, [])

  return (
    <header className={`sticky ${donationBannerVisible ? 'top[0px]' : 'top-0'} z-50 w-full border-b border-border/40 bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/60 transition-all duration-300`}>
      <div className="mx-auto w-full max-w-7xl px-4 md:px-6">
        <div className="flex h-16 items-center justify-between gap-3 md:gap-4">
          {/* Left side - Mobile menu only */}
          <div className="flex items-center gap-4">
            {onMobileMenuToggle && showNavigation && (
              <Button
                variant="ghost"
                size="sm"
                className="md:hidden"
                onClick={onMobileMenuToggle}
              >
                <Menu className="h-5 w-5" />
                <span className="sr-only">Toggle menu</span>
              </Button>
            )}
          </div>

          {/* Search */}
          <HeaderSearch />

          {/* Right side - Actions and user menu */}
          <div className="flex items-center gap-3">

            {/* Theme toggle */}
            <ThemeToggle />

            {/* Notifications */}
            <NotificationBadge />

            {/* User menu */}
            {mounted && isSignedIn && (
              <UserButton
                appearance={{
                  elements: {
                    avatarBox: 'w-9 h-9 rounded-full',
                  },
                }}
                afterSignOutUrl="/"
              />
            )}
          </div>
        </div>
      </div>
    </header>
  )
}
