'use client'

import { useParams } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { Calendar, Hash } from 'lucide-react'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { trpc } from '@/lib/trpc/client'

export default function OrganizationOverviewPage() {
  const params = useParams()
  const orgId = params?.id as string
  const { data: org, isLoading } = trpc.organizations.get.useQuery({ id: orgId })
  const t = useTranslations('orgOverview')
  const tCommon = useTranslations('common')
  const tOrgs = useTranslations('organizations')

  if (isLoading) return <Card className="shadow-card p-6 text-sm text-muted-foreground">{tCommon('loading')}</Card>
  if (!org) return <Card className="shadow-card p-6 text-sm text-muted-foreground">{t('notFound')}</Card>

  return (
    <div className="grid gap-4 sm:grid-cols-2">
      <Card className="shadow-card">
        <CardHeader className="pb-3">
          <CardTitle className="text-sm font-medium text-muted-foreground">{t('details')}</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3 text-sm">
          <div className="flex items-center gap-2">
            <Hash className="h-3.5 w-3.5 text-muted-foreground" />
            <span className="text-muted-foreground">{tOrgs('slug')}</span>
            <span className="ml-auto font-mono text-xs">{org.slug}</span>
          </div>
          <div className="flex items-center gap-2">
            <Calendar className="h-3.5 w-3.5 text-muted-foreground" />
            <span className="text-muted-foreground">{t('createdLabel')}</span>
            <span className="ml-auto text-xs">
              {new Date(org.createdAt).toLocaleDateString(undefined, {
                year: 'numeric',
                month: 'short',
                day: 'numeric'
              })}
            </span>
          </div>
        </CardContent>
      </Card>

      <Card className="shadow-card">
        <CardHeader className="pb-3">
          <CardTitle className="text-sm font-medium text-muted-foreground">
            {t('quickLinks')}
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-2 text-sm">
          <p className="text-xs text-muted-foreground">
            {t('quickLinksDesc')}
          </p>
        </CardContent>
      </Card>
    </div>
  )
}
