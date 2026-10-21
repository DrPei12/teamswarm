import {
  memo,
  useState,
  useEffect,
  useRef,
  Children,
  isValidElement,
  type ComponentProps,
} from "react";
import Markdown, { defaultUrlTransform } from "react-markdown";
import remarkGfm from "remark-gfm";
import { Check, Copy } from "lucide-react";
import { useI18n } from "./i18n";

function CodeBlock({ children, ...props }: ComponentProps<"pre">) {
  const { t } = useI18n();
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const block = useRef<HTMLDivElement>(null);
  useEffect(() => () => clearTimeout(timer.current), []);
  const code = Children.toArray(children).find((child) =>
    isValidElement<{ className?: string }>(child),
  );
  const language = isValidElement<{ className?: string }>(code)
    ? /language-([^ ]+)/.exec(code.props.className ?? "")?.[1]
    : undefined;
  return (
    <div className="code-block" ref={block}>
      <div className="code-header">
        <span>{language || t("Code")}</span>
        <button
          type="button"
          aria-label={t("Copy code")}
          onClick={async () => {
            const text = block.current?.querySelector("pre")?.textContent ?? "";
            try {
              await navigator.clipboard.writeText(text);
              setError(false);
              setCopied(true);
              clearTimeout(timer.current);
              timer.current = setTimeout(() => setCopied(false), 2500);
            } catch {
              setError(true);
            }
          }}
        >
          {copied ? <Check size={13} /> : <Copy size={13} />}
          <span aria-live="polite">
            {t(error ? "Copy failed" : copied ? "Copied" : "Copy code")}
          </span>
        </button>
      </div>
      <pre {...props}>{children}</pre>
    </div>
  );
}
const components = {
  pre: CodeBlock,
  a: ({ children, ...props }: ComponentProps<"a">) =>
    props.href ? (
      <a {...props} target="_blank" rel="noreferrer noopener">
        {children}
      </a>
    ) : (
      <span>{children}</span>
    ),
};
export const MessageContent = memo(function MessageContent({
  text,
  pending = false,
  artifacts = [],
}: {
  text: string;
  pending?: boolean;
  artifacts?: { id: string; name: string; teamId: string }[];
}) {
  return (
    <div className={`message-text markdown ${pending ? "streaming-text" : ""}`}>
      <Markdown
        urlTransform={(url, key) => {
          if (key !== "href" || /^(https?:|mailto:|#|\/\/)/i.test(url))
            return defaultUrlTransform(url);
          let localPath = url.split(/[?#]/, 1)[0];
          try {
            localPath = decodeURIComponent(localPath);
          } catch {
            return "";
          }
          const normalized = localPath.replace(/\\/g, "/").replace(/^\.\//, "");
          const exact = artifacts.find(
            (a) => normalized === a.name.replace(/\\/g, "/"),
          );
          const file =
            exact ??
            (/^(?:[A-Za-z]:\/|\/|file:)/.test(normalized)
              ? [...artifacts]
                  .sort((a, b) => b.name.length - a.name.length)
                  .find((a) =>
                    normalized.endsWith("/" + a.name.replace(/\\/g, "/")),
                  )
              : undefined);
          return file
            ? `/api/product/teams/${file.teamId}/artifacts/${file.id}/download`
            : "";
        }}
        remarkPlugins={[remarkGfm]}
        components={components}
      >
        {text}
      </Markdown>
      {pending && <span className="stream-caret" aria-hidden="true" />}
    </div>
  );
});
