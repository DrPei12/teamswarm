import { ApprovalRequests } from "./ApprovalRequests";
import { ComposerChin, ComposerSurface } from "./design-system/ComposerSurface";
import { SegmentedControl } from "./design-system/SegmentedControl";
import { Select } from "radix-ui";
import { isComposing } from "./design-system/motion";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import {
  ArrowDown,
  ArrowRight,
  ArrowUp,
  CircleHelp,
  Check,
  ChevronDown,
  LoaderCircle,
  MessageSquare,
  Square,
} from "lucide-react";
import type {
  ConversationEntry,
  Exchange,
  MemberConversation as Conversation,
} from "@team/contracts/product";
import type { Work } from "@team/contracts/runtime";
import "./collaboration.css";
import type { Member, Workspace } from "./store";
import { api, product } from "./service";
import { useI18n } from "./i18n";
import { MessageContent } from "./MessageContent";
import { ConversationActivity } from "./ConversationActivity";
import { RuntimeControls } from "./ComposerTools";
import { harnessLabel } from "./harnessCatalog";
import { IconButton, useMediaQuery } from "./ui";
import { executionFeedback } from "./executionFeedback";

const statusLabels: Record<string, string> = {
  queued: "Queued",
  processing: "Receiving",
  delivered: "Received",
  failed: "Failed",
  interrupted: "Paused",
  recovery_required: "Needs reconciliation",
  waiting: "waiting",
};
const exchangeStateLabels = {
  open: "Awaiting reply",
  accepted: "Commitment recorded",
  answered: "Answer recorded",
  resolved: "Exchange resolved",
  cancelled: "Exchange cancelled",
  declined: "Request declined",
};
const readingPositions = new Map<
  string,
  { offset: number; following: boolean; entryId?: string }
>();

type ConversationProps = {
  member: Member;
  workspace: Workspace;
  anchor?: string;
  workId?: string;
  onUpdate: (change: (old: Workspace) => Workspace) => boolean;
  onSettings: (tab?: "harnesses" | "connections") => void;
};
const rootOf = (work: Work) => work.threadId ?? work.id;
export function MemberConversation(props: ConversationProps) {
  const { t } = useI18n();
  const teamWorks =
    props.workspace.executions?.[props.member.teamId]?.works ?? [];
  const runtimeMemberId = props.member.id.startsWith("host:")
    ? teamWorks.find((w) => w.id === props.member.workId)?.memberId
    : props.member.id;
  const memberWorks = teamWorks.filter((w) => w.memberId === runtimeMemberId);
  const works = memberWorks.filter(
    (w) => !w.interaction && w.kind !== "collaboration",
  );
  const threads = [...new Map(works.map((w) => [rootOf(w), w])).values()];
  const exchange = props.workspace.connections
    .flatMap((c) => c.exchanges ?? [])
    .find((e) => e.id === props.anchor);
  const anchored = works.find(
    (w) =>
      w.id === props.workId ||
      `assignment:${w.id}` === props.anchor ||
      w.id ===
        (exchange?.source === props.member.id
          ? (exchange.sourceWorkId ?? exchange.workId)
          : (exchange?.targetWorkId ?? exchange?.workId)),
  );
  const unscopedAnchor = !!exchange && !anchored;
  const recent = threads.reduce<Work | undefined>(
    (latest, work) =>
      !latest || work.updatedAt > latest.updatedAt ? work : latest,
    undefined,
  );
  const [selection, setSelection] = useState<string | undefined>(() =>
    anchored
      ? rootOf(anchored)
      : unscopedAnchor
        ? "member"
        : recent
          ? rootOf(recent)
          : undefined,
  );
  const anchoredRoot = anchored ? rootOf(anchored) : undefined;
  useEffect(() => {
    if (anchoredRoot) setSelection(anchoredRoot);
    else if (unscopedAnchor) setSelection("member");
  }, [props.anchor, anchoredRoot, unscopedAnchor]);
  const chosen =
    selection === "member"
      ? undefined
      : (threads.find((w) => rootOf(w) === selection) ??
        (anchored
          ? threads.find((w) => rootOf(w) === rootOf(anchored))
          : undefined) ??
        recent);
  return (
    <div className="work-thread-panel">
      {!!threads.length && (
        <div className="work-thread-picker">
          <Select.Root
            value={chosen ? rootOf(chosen) : "member"}
            onValueChange={setSelection}
          >
            <Select.Trigger
              className="work-thread-trigger"
              aria-label={t("Work thread")}
            >
              <Select.Value />
              <Select.Icon>
                <ChevronDown size={14} />
              </Select.Icon>
            </Select.Trigger>
            <Select.Portal>
              <Select.Content
                className="menu work-thread-menu"
                position="popper"
                sideOffset={6}
                collisionPadding={12}
              >
                <Select.ScrollUpButton className="thread-menu-scroll">
                  <ChevronDown size={14} />
                </Select.ScrollUpButton>
                <Select.Viewport>
                  {[
                    { id: "member", title: t("Conversation") },
                    ...threads.map((w) => ({
                      id: rootOf(w),
                      title: w.title.startsWith("Review: ")
                        ? `${t("Review")} · ${w.title.slice(8)}`
                        : w.title,
                    })),
                  ].map((item) => (
                    <Select.Item
                      key={item.id}
                      value={item.id}
                      className="menu-item work-thread-option"
                    >
                      <Select.ItemText>{item.title}</Select.ItemText>
                      <Select.ItemIndicator>
                        <Check size={14} />
                      </Select.ItemIndicator>
                    </Select.Item>
                  ))}
                </Select.Viewport>
                <Select.ScrollDownButton className="thread-menu-scroll">
                  <ChevronDown size={14} />
                </Select.ScrollDownButton>
              </Select.Content>
            </Select.Portal>
          </Select.Root>
        </div>
      )}
      <ConversationThread
        key={`${props.member.id}:${chosen ? rootOf(chosen) : "member"}`}
        {...props}
        work={chosen}
      />
    </div>
  );
}

function ConversationThread({
  member,
  workspace,
  anchor,
  onUpdate,
  onSettings,
  work,
}: ConversationProps & { work?: Work }) {
  const { t, locale } = useI18n();
  const [entries, setEntries] = useState<ConversationEntry[]>([]);
  const [canSend, setCanSend] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [loadError, setLoadError] = useState("");
  const [sending, setSending] = useState(false);
  const [retrying, setRetrying] = useState<string | null>(null);
  const [configuring, setConfiguring] = useState(false);
  const configurationLock = useRef(false);
  const team = workspace.teams.find((t) => t.id === member.teamId)!;
  const executionConfig = member.id.startsWith("host:")
    ? workspace.executions?.[member.teamId]?.settings?.config
    : member.executionConfig;
  const runtimeConfig = executionConfig
    ? {
        harness: harnessLabel(executionConfig.harness),
        model: executionConfig.model ?? "",
        effort: executionConfig.effort ?? "Default",
      }
    : {
        harness: member.harness,
        model: member.model,
        effort: member.effort ?? "Default",
      };
  const [mode, setMode] = useState<"discuss" | "revise">("discuss");
  const [hasMore, setHasMore] = useState(false);
  const [hasNewer, setHasNewer] = useState(false);
  const [loadingEarlier, setLoadingEarlier] = useState(false);
  const [following, setFollowing] = useState(!anchor);
  const [highlight, setHighlight] = useState("");
  const [requestAnchor, setRequestAnchor] = useState(() => {
    const saved = readingPositions.get(
      `${member.teamId}:${work ? rootOf(work) : member.id}`,
    );
    return anchor ?? (saved && !saved.following ? saved.entryId : undefined);
  });
  const previousAnchor = useRef(anchor);
  const loadedWindow = useRef(requestAnchor);
  const navigation = useRef(requestAnchor);
  navigation.current = requestAnchor;
  const scroller = useRef<HTMLDivElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLTextAreaElement>(null);
  const follow = useRef(!anchor);
  const inspectingActivity = useRef(false);
  const located = useRef("");
  const cancelled = useRef(false);
  const mounted = useRef(true);
  const restored = useRef(false);
  const loadedStart = useRef<number | undefined>(undefined);
  const prependPosition = useRef<{ id: string; offset: number } | null>(null);
  const locatingUntil = useRef(0);
  const entriesRef = useRef(entries);
  entriesRef.current = entries;
  const reduced = useMediaQuery("(prefers-reduced-motion: reduce)");
  const cursor = workspace.executions?.[member.teamId]?.latestEvent ?? 0;
  const draftKey = work
    ? `work:${member.teamId}:${rootOf(work)}`
    : `member:${member.teamId}:${member.id}`;
  const draft = workspace.drafts[draftKey]?.text ?? "";
  const url = work
    ? `/product/teams/${encodeURIComponent(member.teamId)}/works/${encodeURIComponent(work.id)}/conversation`
    : `/product/teams/${encodeURIComponent(member.teamId)}/members/${encodeURIComponent(member.id)}/conversation`;
  const positionKey = `${member.teamId}:${work ? rootOf(work) : member.id}`;
  const activeWork = work
    ? workspace.executions?.[member.teamId]?.works.find(
        (w) =>
          rootOf(w) === rootOf(work) &&
          ["queued", "running", "stopping", "recovery_required"].includes(
            w.status,
          ),
      )
    : undefined;
  useLayoutEffect(() => {
    const el = scroller.current;
    return () => {
      if (el) {
        const top = el.getBoundingClientRect().top;
        const visible = [
          ...el.querySelectorAll<HTMLElement>("[data-entry-id]"),
        ].find((entry) => entry.getBoundingClientRect().bottom > top);
        if (!visible) return;
        readingPositions.set(positionKey, {
          offset: (visible?.getBoundingClientRect().top ?? top) - top,
          following: follow.current,
          entryId: visible?.dataset.entryId,
        });
        if (readingPositions.size > 100)
          readingPositions.delete(readingPositions.keys().next().value!);
      }
    };
  }, [positionKey]);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  useEffect(() => {
    if (previousAnchor.current === anchor) return;
    previousAnchor.current = anchor;
    setRequestAnchor(anchor);
    located.current = "";
    cancelled.current = false;
    if (anchor) {
      follow.current = false;
      setFollowing(false);
    }
  }, [anchor]);
  useEffect(() => {
    const controller = new AbortController();
    void api<Conversation>(
      url +
        (requestAnchor ? `?anchor=${encodeURIComponent(requestAnchor)}` : ""),
      undefined,
      "GET",
      controller.signal,
    )
      .then((data) => {
        if (controller.signal.aborted) return;
        const reset =
          loadedWindow.current !== requestAnchor ||
          (entriesRef.current.length > 0 &&
            !data.entries.some((entry) =>
              entriesRef.current.some((old) => old.id === entry.id),
            ));
        loadedWindow.current = requestAnchor;
        setEntries((old) => {
          const merged = new Map(
            (reset ? [] : old).map((entry) => [entry.id, entry]),
          );
          for (const entry of data.entries) merged.set(entry.id, entry);
          return [...merged.values()].sort(
            (a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id),
          );
        });
        loadedStart.current = Math.min(
          reset ? Infinity : (loadedStart.current ?? Infinity),
          data.before ?? 0,
        );
        setCanSend(data.canSend);
        setHasMore(loadedStart.current > 0);
        setHasNewer(!!data.hasNewer);
        setLoadError("");
        setLoading(false);
        if (requestAnchor && !data.entries.some((e) => e.id === requestAnchor))
          setLoadError(t("This message is no longer available."));
      })
      .catch((e: Error) => {
        if (!controller.signal.aborted) {
          setLoadError(e.message);
          setLoading(false);
        }
      });
    return () => controller.abort();
  }, [url, cursor, requestAnchor, t, positionKey]);
  useLayoutEffect(() => {
    const container = scroller.current;
    if (!container) return;
    if (prependPosition.current) {
      const saved = prependPosition.current;
      const target = [
        ...container.querySelectorAll<HTMLElement>("[data-entry-id]"),
      ].find((entry) => entry.dataset.entryId === saved.id);
      if (target)
        container.scrollTop +=
          target.getBoundingClientRect().top -
          container.getBoundingClientRect().top -
          saved.offset;
      prependPosition.current = null;
      return;
    }
    if (!loading && !restored.current) {
      restored.current = true;
      const saved = !anchor ? readingPositions.get(positionKey) : undefined;
      if (saved && !saved.following) {
        follow.current = false;
        setFollowing(false);
        const target = [
          ...container.querySelectorAll<HTMLElement>("[data-entry-id]"),
        ].find((entry) => entry.dataset.entryId === saved.entryId);
        if (target)
          container.scrollTop +=
            target.getBoundingClientRect().top -
            container.getBoundingClientRect().top -
            saved.offset;
        located.current = requestAnchor ?? "";
        return;
      }
    }
    if (
      requestAnchor &&
      located.current !== requestAnchor &&
      !cancelled.current
    ) {
      const target = [
        ...container.querySelectorAll<HTMLElement>("[data-entry-id]"),
      ].find((e) => e.dataset.entryId === requestAnchor);
      if (target) {
        const frame = requestAnimationFrame(() => {
          if (cancelled.current) return;
          locatingUntil.current = performance.now() + 900;
          target.scrollIntoView({
            block:
              target.offsetHeight > container.clientHeight * 0.7
                ? "start"
                : "center",
            behavior: reduced ? "instant" : "smooth",
          });
          target.focus({ preventScroll: true });
          setHighlight(requestAnchor);
          located.current = requestAnchor;
        });
        return () => cancelAnimationFrame(frame);
      }
    } else if (follow.current) container.scrollTop = container.scrollHeight;
  }, [entries, requestAnchor, reduced, loading, positionKey, anchor]);
  useEffect(() => {
    if (!highlight) return;
    const timer = setTimeout(() => setHighlight(""), 1800);
    return () => clearTimeout(timer);
  }, [highlight]);
  useEffect(() => {
    if (!list.current) return;
    const observer = new ResizeObserver(() => {
      if (follow.current && scroller.current)
        scroller.current.scrollTop = scroller.current.scrollHeight;
      if (
        !loading &&
        (!requestAnchor ||
          cancelled.current ||
          located.current === requestAnchor)
      )
        syncScrollPosition();
    });
    observer.observe(list.current);
    if (scroller.current) observer.observe(scroller.current);
    return () => observer.disconnect();
  }, [hasNewer, requestAnchor, loading]);
  useLayoutEffect(() => {
    if (input.current && !CSS.supports("field-sizing", "content")) {
      input.current.style.height = "0px";
      input.current.style.height = `${Math.min(260, Math.max(24, input.current.scrollHeight))}px`;
    }
  }, [draft]);
  const stopAutoScroll = () => {
    cancelled.current = true;
    locatingUntil.current = 0;
    follow.current = false;
    const el = scroller.current;
    if (el) el.scrollTo({ top: el.scrollTop, behavior: "instant" });
  };
  const syncScrollPosition = () => {
    const el = scroller.current;
    if (!el || performance.now() < locatingUntil.current) return;
    const bottom = el.scrollHeight - el.scrollTop - el.clientHeight <= 24;
    follow.current = bottom && !hasNewer && !inspectingActivity.current;
    setFollowing(bottom && !hasNewer);
    if (bottom && !hasNewer && requestAnchor && cancelled.current)
      setRequestAnchor(undefined);
  };
  const send = async () => {
    if (!draft.trim() || sending || !canSend || configurationLock.current)
      return;
    setSending(true);
    setError("");
    try {
      if (work)
        await product.sendWork(member.teamId, work, draft, mode, draftKey);
      else await product.sendMember(member.teamId, member.id, draft);
      if (!mounted.current) return;
      setRequestAnchor(undefined);
      inspectingActivity.current = false;
      follow.current = true;
      setFollowing(true);
      input.current?.focus();
    } catch (e) {
      if (mounted.current) setError((e as Error).message);
    } finally {
      if (mounted.current) setSending(false);
    }
  };
  return (
    <div className="member-conversation">
      <div
        className="member-thread"
        ref={scroller}
        onWheel={(event) => {
          inspectingActivity.current = false;
          stopAutoScroll();
          // Wheel intent and distance from the bottom are separate signals.
          // At the boundary another downward wheel may produce no scroll event.
          if (event.deltaY >= 0) syncScrollPosition();
        }}
        onTouchStart={() => {
          inspectingActivity.current = false;
          stopAutoScroll();
        }}
        onClickCapture={(event) => {
          if (
            (event.target as Element).closest(
              ".activity-summary, .activity-toggle",
            )
          ) {
            inspectingActivity.current = true;
            stopAutoScroll();
          }
        }}
        onKeyDown={(e) => {
          if (
            [
              "PageUp",
              "PageDown",
              "Home",
              "End",
              "ArrowUp",
              "ArrowDown",
            ].includes(e.key)
          ) {
            inspectingActivity.current = false;
            stopAutoScroll();
          }
        }}
        onScroll={syncScrollPosition}
        onPointerDownCapture={(event) => {
          if (
            !(event.target as Element).closest(
              ".activity-summary, .activity-toggle",
            )
          )
            inspectingActivity.current = false;
        }}
      >
        <div ref={list} className="member-thread-content">
          <ApprovalRequests
            teamId={member.teamId}
            memberId={member.id}
            workspace={workspace}
          />
          {hasMore && (
            <button
              className="load-earlier"
              disabled={loadingEarlier}
              onClick={async () => {
                setLoadingEarlier(true);
                const el = scroller.current;
                const requestedWindow = requestAnchor;
                follow.current = false;
                try {
                  const data = await api<Conversation>(
                    `${url}?before=${encodeURIComponent(entries[0]?.id ?? "")}`,
                  );
                  if (
                    !mounted.current ||
                    navigation.current !== requestedWindow
                  )
                    return;
                  if (el) {
                    const top = el.getBoundingClientRect().top;
                    const visible = [
                      ...el.querySelectorAll<HTMLElement>("[data-entry-id]"),
                    ].find(
                      (entry) => entry.getBoundingClientRect().bottom > top,
                    );
                    if (visible?.dataset.entryId)
                      prependPosition.current = {
                        id: visible.dataset.entryId,
                        offset: visible.getBoundingClientRect().top - top,
                      };
                  }
                  setEntries((old) => {
                    const map = new Map(
                      [...data.entries, ...old].map((e) => [e.id, e]),
                    );
                    return [...map.values()];
                  });
                  loadedStart.current = data.before;
                  setHasMore(data.hasMore);
                } catch (e) {
                  if (mounted.current) setError((e as Error).message);
                } finally {
                  if (mounted.current) setLoadingEarlier(false);
                }
              }}
            >
              {t("Load earlier messages")}
            </button>
          )}
          {loading && (
            <div className="thread-empty">
              <LoaderCircle size={18} className="spin" />
              {t("Loading conversation…")}
            </div>
          )}
          {!loading && !entries.length && (
            <div className="thread-empty">
              <MessageSquare size={24} />
              <p>{t("No messages yet")}</p>
            </div>
          )}
          {entries.map((entry) => (
            <article
              key={entry.id}
              data-entry-id={entry.id}
              tabIndex={-1}
              className={`member-entry ${entry.role} ${entry.id === highlight ? "message-focus" : ""}`}
            >
              <div className="member-entry-meta">
                <span>
                  {entry.role === "assistant"
                    ? t("Work session")
                    : t(entry.sender)}
                  {entry.role === "outgoing" &&
                    entry.recipient &&
                    ` → ${t(entry.recipient)}`}
                </span>
                <time dateTime={new Date(entry.createdAt).toISOString()}>
                  {new Date(entry.createdAt).toLocaleTimeString(locale, {
                    hour: "2-digit",
                    minute: "2-digit",
                  })}
                </time>
                {entry.role !== "assistant" && entry.status && (
                  <span className={`delivery-status ${entry.status}`}>
                    {entry.readByRecipient === undefined
                      ? t(statusLabels[entry.status] ?? entry.status)
                      : t(
                          entry.late
                            ? "Late reply"
                            : entry.readByRecipient
                              ? "Read"
                              : "Unread",
                        )}
                  </span>
                )}
                {entry.exchangeStatus && (
                  <span>{t(exchangeStateLabels[entry.exchangeStatus])}</span>
                )}
              </div>
              {entry.items && (
                <ConversationActivity
                  items={entry.items}
                  members={workspace.members.filter(
                    (m) => m.teamId === member.teamId,
                  )}
                  running={entry.status === "running"}
                  elapsedMs={entry.elapsedMs}
                />
              )}
              {entry.text && (
                <MessageContent
                  text={
                    entry.id.startsWith("error:")
                      ? t(executionFeedback(entry.text))
                      : entry.text
                  }
                  pending={entry.status === "running"}
                />
              )}
              {entry.messageKind === "accept" && entry.commitment && (
                <div className="session-status">
                  <strong>{t("Commitment")}: </strong>
                  {entry.commitment.text}
                  {" · "}
                  {t("Due")}{" "}
                  <time dateTime={entry.commitment.dueAt}>
                    {new Date(entry.commitment.dueAt).toLocaleString(locale)}
                  </time>
                </div>
              )}
              {entry.role === "assistant" &&
                entry.status === "running" &&
                !entry.text &&
                !entry.items?.length && (
                  <div className="session-progress">{t("Working…")}</div>
                )}
              {entry.role === "assistant" &&
                !entry.id.startsWith("error:") &&
                [
                  "failed",
                  "interrupted",
                  "recovery_required",
                  "waiting",
                ].includes(entry.status ?? "") && (
                  <div className="session-status">
                    {(entry.error ? t(executionFeedback(entry.error)) : "") ||
                      t(statusLabels[entry.status!] ?? entry.status!)}
                  </div>
                )}
              {entry.retryWorkId && !member.removedAt && (
                <button
                  className="text-button"
                  disabled={!!retrying}
                  onClick={async () => {
                    const failed = workspace.executions?.[
                      member.teamId
                    ]?.works.find((w) => w.id === entry.retryWorkId);
                    if (!failed) return;
                    setRetrying(entry.id);
                    setError("");
                    try {
                      await api(
                        `/teams/${encodeURIComponent(member.teamId)}/works/${encodeURIComponent(failed.id)}/retry`,
                        { expectedRevision: failed.revision },
                      );
                      await product.refresh();
                    } catch (e) {
                      setError(executionFeedback((e as Error).message));
                    } finally {
                      setRetrying(null);
                    }
                  }}
                >
                  {retrying === entry.id ? (
                    <LoaderCircle size={14} className="spin" />
                  ) : null}
                  {t("Retry")}
                </button>
              )}
            </article>
          ))}
        </div>
      </div>
      {(error || loadError) && (
        <div className="member-error" role="alert">
          {t(error || loadError)}
        </div>
      )}
      {!member.removedAt && (
        <ComposerSurface
          className="member-composer"
          onSubmit={(e) => {
            e.preventDefault();
            void send();
          }}
        >
          {(!following || hasNewer) && (
            <button
              type="button"
              className="thread-bottom"
              aria-label={t("Scroll to latest")}
              onClick={() => {
                setRequestAnchor(undefined);
                locatingUntil.current = 0;
                inspectingActivity.current = false;
                follow.current = true;
                setFollowing(true);
                scroller.current?.scrollTo({
                  top: scroller.current.scrollHeight,
                  behavior: reduced ? "instant" : "smooth",
                });
              }}
            >
              <ArrowDown size={15} />
              {t("Latest")}
            </button>
          )}
          <textarea
            ref={input}
            aria-label={t("Message {name}", { name: member.name })}
            placeholder={
              canSend
                ? t("Message {name}…", { name: member.name })
                : t("Waiting for an assignment")
            }
            value={draft}
            disabled={!canSend}
            onChange={(e) => {
              const text = e.target.value;
              onUpdate((old) => ({
                ...old,
                drafts: { ...old.drafts, [draftKey]: { text, files: [] } },
              }));
            }}
            onKeyDown={(e) => {
              if (
                e.key === "Enter" &&
                !e.shiftKey &&
                !isComposing(e.nativeEvent)
              ) {
                e.preventDefault();
                void send();
              }
            }}
          />
          <ComposerChin className="member-composer-toolbar">
            {work && !work.reviewOf && (
              <div className="work-message-mode">
                <SegmentedControl
                  value={mode}
                  onChange={setMode}
                  label={t("Message purpose")}
                  options={[
                    { value: "discuss", label: t("Ask a question") },
                    {
                      value: "revise",
                      label: t("Continue modifying"),
                      disabled: !!activeWork,
                    },
                  ]}
                />
              </div>
            )}
            <div className="member-composer-config">
              <RuntimeControls
                team={team}
                config={runtimeConfig}
                executionConfig={executionConfig}
                showContext={false}
                disabled={configuring || sending || !executionConfig}
                onSettings={onSettings}
                onChange={async (config, choice) => {
                  if (configurationLock.current) return;
                  configurationLock.current = true;
                  setConfiguring(true);
                  setError("");
                  try {
                    await product.configureMember(
                      member.teamId,
                      member.id,
                      config,
                      choice,
                    );
                  } catch (error) {
                    if (mounted.current) setError((error as Error).message);
                  } finally {
                    configurationLock.current = false;
                    if (mounted.current) setConfiguring(false);
                  }
                }}
              />
              {canSend && (
                <IconButton
                  className="member-composer-help"
                  label={t(
                    work
                      ? mode === "discuss"
                        ? "Questions keep project files unchanged."
                        : "Continue this work using its existing files and requirements."
                      : "Follow up here. Assign project changes through Host.",
                  )}
                  aria-label={t("About member conversations")}
                >
                  <CircleHelp size={14} />
                </IconButton>
              )}
            </div>
            {(work
              ? activeWork
              : member.status === "working" && member.workId) && (
              <button
                type="button"
                aria-label={t("Stop member")}
                onClick={async () => {
                  try {
                    await product.command(
                      `/teams/${member.teamId}/works/${activeWork?.id ?? member.workId}/stop`,
                      {},
                    );
                  } catch (e) {
                    setError((e as Error).message);
                  }
                }}
              >
                <Square size={13} />
              </button>
            )}
            <button
              type="submit"
              className="member-send"
              disabled={
                !canSend ||
                !draft.trim() ||
                sending ||
                configuring ||
                (mode === "revise" && !!activeWork)
              }
              aria-label={t("Send message")}
            >
              {sending ? (
                <LoaderCircle size={15} className="spin" />
              ) : (
                <ArrowUp size={17} />
              )}
            </button>
          </ComposerChin>
        </ComposerSurface>
      )}
    </div>
  );
}

export function ExchangeList({
  exchanges,
  members,
  onOpen,
}: {
  exchanges: Exchange[];
  members: Member[];
  onOpen: (memberId: string, messageId: string) => void;
}) {
  const { t, locale } = useI18n();
  const name = (id: string) => members.find((m) => m.id === id)?.name ?? id;
  return (
    <div className="exchange-list">
      <p className="exchange-intro">
        {t("Open an exchange to see it in the recipient's conversation.")}
      </p>
      {!exchanges.length && (
        <div className="thread-empty">{t("No messages yet")}</div>
      )}
      {[...exchanges].reverse().map((exchange) => (
        <button
          key={exchange.id}
          className={`exchange-row ${exchange.status}`}
          onClick={() => onOpen(exchange.target, exchange.id)}
        >
          <span className="exchange-route">
            <strong>{name(exchange.source)}</strong>
            <ArrowRight size={13} />
            <strong>{name(exchange.target)}</strong>
            <time>
              {new Date(exchange.createdAt).toLocaleString(locale, {
                month: "short",
                day: "numeric",
                hour: "2-digit",
                minute: "2-digit",
              })}
            </time>
          </span>
          <span className="exchange-copy">{exchange.content}</span>
          <span className="exchange-meta">
            {exchange.kind === "assignment" ? t("Assignment") : t("Message")}
            <span>
              {exchange.readByRecipient === undefined
                ? t(statusLabels[exchange.status])
                : t(
                    exchange.late
                      ? "Late reply"
                      : exchange.readByRecipient
                        ? "Read"
                        : "Unread",
                  )}
            </span>
            {exchange.exchangeStatus && (
              <span>{t(exchangeStateLabels[exchange.exchangeStatus])}</span>
            )}
          </span>
          {exchange.messageKind === "accept" && exchange.commitment && (
            <span className="exchange-copy">
              {t("Commitment")}: {exchange.commitment.text}
            </span>
          )}
        </button>
      ))}
    </div>
  );
}
