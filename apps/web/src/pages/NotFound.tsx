import { Link } from "react-router-dom";
import { APP_HOME_PATH } from "@canary/shared";

export function NotFound({
  title = "Page not found",
  message = "That link does not point at anything Canary knows about.",
}: {
  title?: string;
  message?: string;
}) {
  return (
    <div className="rounded-2xl border border-neutral-200 bg-white p-8 text-center sm:p-12">
      <p className="text-xs font-semibold uppercase tracking-wide text-neutral-400">404</p>
      <h1 className="mt-2 text-lg font-semibold text-neutral-900">{title}</h1>
      <p className="mx-auto mt-1 max-w-sm text-sm leading-relaxed text-neutral-600">{message}</p>
      <Link
        to={APP_HOME_PATH}
        className="mt-5 inline-block text-sm font-medium text-neutral-900 underline-offset-4 hover:underline"
      >
        ← Back to dashboard
      </Link>
    </div>
  );
}
