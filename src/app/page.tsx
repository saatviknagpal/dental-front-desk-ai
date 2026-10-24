import Link from "next/link";
import Icon from "@/components/Icon";
import { PRACTICES } from "@/lib/practice";

export default function Home() {
  return (
    <main className="mx-auto flex min-h-dvh max-w-3xl flex-col justify-center px-4 py-10">
      <div className="mb-8 flex items-center gap-3">
        <div className="grid size-11 place-items-center rounded-xl bg-brand text-on-brand" aria-hidden="true">
          <Icon name="tooth" className="size-6" />
        </div>
        <div>
          <h1 className="text-2xl font-bold">Choose your dental office</h1>
          <p className="text-muted">Book, move or cancel a visit, or ask a question.</p>
        </div>
      </div>
      <ul className="grid gap-3 sm:grid-cols-2">
        {PRACTICES.map((p) => (
          <li key={p.slug}>
            <Link
              href={`/p/${p.slug}`}
              className="flex h-full flex-col gap-3 rounded-xl border border-border bg-surface p-5 transition-colors hover:border-brand hover:bg-brand-soft"
            >
              <span className="text-lg font-bold">{p.name}</span>
              <span className="flex gap-2 text-sm text-muted">
                <Icon name="mapPin" className="mt-0.5 size-4" />
                {p.address}
              </span>
              <span className="flex gap-2 text-sm text-muted">
                <Icon name="clock" className="mt-0.5 size-4" />
                {p.hoursText}
              </span>
              <span className="mt-auto inline-flex items-center gap-1.5 pt-1 text-sm font-bold text-brand-strong">
                Chat with {p.assistantName}
                <Icon name="arrowUp" className="size-4 rotate-90" />
              </span>
            </Link>
          </li>
        ))}
      </ul>
      <p className="mt-8 text-sm text-muted">
        Staff? <Link href="/staff" className="underline underline-offset-2 hover:text-text">Open the front desk dashboard</Link>
      </p>
    </main>
  );
}
