import { useMutation, useQueryClient } from '@tanstack/react-query'
import { ChevronsDown } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '#/components/ui/button'
import { expandPage } from '#/server/functions/crawls'

const LEVELS = [1, 2, 3] as const

interface Props {
  crawlId: string
  /** The page whose branch goes deeper; the root page extends the whole crawl. */
  pageId: string
  disabled?: boolean
  size?: 'xs' | 'sm'
}

/** "Go deeper +1 / +2 / +3": crawl that many more levels below a page. */
export function GoDeeper({ crawlId, pageId, disabled, size = 'sm' }: Props) {
  const queryClient = useQueryClient()
  const expand = useMutation({
    mutationFn: expandPage,
    onSuccess: ({ queued }) => {
      if (queued === 0) toast.message('Nothing new to crawl: every page it links to is already on the board.')
      else toast.success(`Queued ${queued} ${queued === 1 ? 'page' : 'pages'}`)
      return queryClient.invalidateQueries({ queryKey: ['crawls'] })
    },
    onError: (err) => toast.error(err.message),
  })

  return (
    <div className="flex items-center border" role="group" aria-label="Go deeper">
      <span className="text-muted-foreground flex items-center gap-1 px-2 text-xs">
        <ChevronsDown className="size-3.5" />
        Go deeper
      </span>
      {LEVELS.map((levels) => (
        <Button
          key={levels}
          variant="ghost"
          size={size}
          disabled={disabled || expand.isPending}
          onClick={() => expand.mutate({ data: { crawlId, pageId, levels } })}
          title={`Crawl ${levels} more ${levels === 1 ? 'level' : 'levels'} of links`}
        >
          +{levels}
        </Button>
      ))}
    </div>
  )
}
