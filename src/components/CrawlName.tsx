import { useRef, useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useRouter } from '@tanstack/react-router'
import { Pencil } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '#/components/ui/button'
import { Input } from '#/components/ui/input'
import { crawlQuery, crawlTitle, type CrawlDetail } from '#/lib/queries'
import { crawlNameSchema } from '#/lib/schemas'
import { renameCrawl } from '#/server/functions/crawls'

/** The crawl page heading; click the pencil (or double-click) to rename the crawl. */
export function CrawlName({ crawl }: { crawl: CrawlDetail['crawl'] }) {
  const queryClient = useQueryClient()
  const router = useRouter()
  const [draft, setDraft] = useState<string | null>(null)
  // Enter and Escape close the editor, which blurs it; don't let that save a second time.
  const closing = useRef(false)

  const { queryKey } = crawlQuery(crawl.id)
  const rename = useMutation({
    mutationFn: renameCrawl,
    onMutate: async ({ data }) => {
      await queryClient.cancelQueries({ queryKey })
      const previous = queryClient.getQueryData(queryKey)
      queryClient.setQueryData(queryKey, (old) =>
        old && { ...old, crawl: { ...old.crawl, name: data.name } },
      )
      return { previous }
    },
    onError: (err, _vars, context) => {
      if (context?.previous) queryClient.setQueryData(queryKey, context.previous)
      toast.error(err.message)
    },
    onSettled: async () => {
      await queryClient.invalidateQueries({ queryKey: ['crawls'] })
      // The tab title comes from the route loader.
      await router.invalidate()
    },
  })

  const startEditing = () => {
    closing.current = false
    setDraft(crawl.name ?? '')
  }

  const save = () => {
    if (closing.current || draft === null) return
    const parsed = crawlNameSchema.safeParse(draft)
    if (!parsed.success) {
      toast.error(parsed.error.issues[0].message)
      return
    }
    closing.current = true
    setDraft(null)
    if (parsed.data !== crawl.name) rename.mutate({ data: { crawlId: crawl.id, name: parsed.data } })
  }

  if (draft !== null) {
    return (
      <Input
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={save}
        onKeyDown={(e) => {
          if (e.key === 'Enter') save()
          if (e.key === 'Escape') {
            closing.current = true
            setDraft(null)
          }
        }}
        placeholder={crawl.rootUrl}
        aria-label="Crawl name"
        maxLength={120}
        className="h-7 w-80 max-w-full px-2 font-semibold"
        autoFocus
      />
    )
  }

  return (
    <div className="group flex min-w-0 items-center gap-1">
      <h1 className="truncate font-semibold" onDoubleClick={startEditing} title={crawlTitle(crawl)}>
        {crawlTitle(crawl)}
      </h1>
      <Button
        variant="ghost"
        size="icon"
        className="size-7 shrink-0"
        aria-label="Rename crawl"
        title="Rename"
        onClick={startEditing}
      >
        <Pencil className="size-3.5" />
      </Button>
    </div>
  )
}
