import { useState } from "react";
import { Trash2 } from "lucide-react";
import type { Member } from "./store";
import { Modal } from "./ui";
import { product } from "./service";
import { useI18n } from "./i18n";

export function DeletedMembers({
  members,
  onView,
  onRemoved,
}: {
  members: Member[];
  onView: (member: Member) => void;
  onRemoved: (id: string) => void;
}) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const [selected, setSelected] = useState<Member | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const visible = members.filter(
    (member) => member.removedAt && !member.purgedAt,
  );
  if (!visible.length && !open) return null;
  return (
    <>
      <button
        className="text-button"
        onClick={() => {
          setSelected(null);
          setError("");
          setOpen(true);
        }}
      >
        {t("Deleted members")}
      </button>
      <Modal
        open={open}
        onOpenChange={(value) => {
          if (!busy) setOpen(value);
        }}
        title={t(
          selected ? "Remove member entry permanently" : "Deleted members",
        )}
      >
        <div className="form-body deleted-members-body">
          {selected ? (
            <>
              <p>
                {t('Remove "{name}" from member lists permanently?', {
                  name: selected.name,
                })}
              </p>
              <p>
                {t("Conversations, results and author records will be kept.")}
              </p>
            </>
          ) : visible.length ? (
            visible.map((member) => (
              <div className="deleted-member-row" key={member.id}>
                <strong>{member.name}</strong>
                <button
                  className="text-button"
                  onClick={() => {
                    setOpen(false);
                    onView(member);
                  }}
                >
                  {t("View history")}
                </button>
                <button
                  className="text-button danger-text"
                  onClick={() => {
                    setError("");
                    setSelected(member);
                  }}
                  aria-label={t('Remove "{name}" permanently', {
                    name: member.name,
                  })}
                >
                  <Trash2 size={15} />
                  {t("Remove permanently")}
                </button>
              </div>
            ))
          ) : (
            <p>{t("No deleted members")}</p>
          )}
          {error && (
            <p className="form-error" role="alert">
              {t(error)}
            </p>
          )}
        </div>
        <div className="form-footer">
          <button
            autoFocus={!!selected}
            type="button"
            className="secondary-button"
            disabled={busy}
            onClick={() => (selected ? setSelected(null) : setOpen(false))}
          >
            {t(selected ? "Cancel" : "Close")}
          </button>
          {selected && (
            <button
              className="danger-button"
              disabled={busy}
              onClick={async () => {
                if (busy) return;
                setBusy(true);
                setError("");
                try {
                  await product.purgeMemberEntry(
                    selected.teamId,
                    selected.id,
                    selected.removedAt!,
                  );
                  onRemoved(selected.id);
                  setSelected(null);
                } catch (e) {
                  setError((e as Error).message);
                } finally {
                  setBusy(false);
                }
              }}
            >
              {t(busy ? "Removing…" : "Remove permanently")}
            </button>
          )}
        </div>
      </Modal>
    </>
  );
}
