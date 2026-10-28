import { useEffect, useState } from "react";
import { File, X } from "lucide-react";
import { downloadFile, type Attachment } from "./store";
import { Modal } from "./ui";
import { useI18n } from "./i18n";

export function clipboardFiles(data: DataTransfer): File[] {
  if (data.files.length) return Array.from(data.files);
  return Array.from(data.items)
    .filter((item) => item.kind === "file")
    .map((item) => item.getAsFile())
    .filter((file): file is File => !!file);
}

export function AttachmentChip({
  file,
  onRemove,
  onError,
}: {
  file: Attachment;
  onRemove?: () => void;
  onError: (message: string) => void;
}) {
  const { t } = useI18n();
  const [preview, setPreview] = useState("");
  const [open, setOpen] = useState(false);
  const image = /^image\/(png|jpeg|gif|webp|avif|bmp|x-icon)$/i.test(file.type);
  useEffect(() => {
    setPreview("");
    if (!image) return;
    const controller = new AbortController();
    let url = "";
    void fetch(`/api/product/files/${encodeURIComponent(file.id)}`, {
      signal: AbortSignal.any([controller.signal, AbortSignal.timeout(20000)]),
    })
      .then(async (response) => {
        if (!response.ok) throw new Error("Couldn’t open file. Try again.");
        const bytes = await response.blob();
        if (controller.signal.aborted) return;
        url = URL.createObjectURL(new Blob([bytes], { type: file.type }));
        setPreview(url);
      })
      .catch((error) => {
        if (!controller.signal.aborted) onError(t(error.message));
      });
    return () => {
      controller.abort();
      if (url) URL.revokeObjectURL(url);
    };
  }, [file.id, file.type, image]);
  const download = () =>
    void downloadFile(file).catch(() =>
      onError(t("Couldn’t open file. Try again.")),
    );
  return (
    <>
      <span className={`file-chip ${image ? "image-attachment" : ""}`}>
        <button
          type="button"
          title={file.name}
          aria-label={
            image ? t("Preview {name}", { name: file.name }) : file.name
          }
          onClick={() => (image ? setOpen(true) : download())}
        >
          {preview ? <img src={preview} alt={file.name} /> : <File size={18} />}
          <span>{file.name}</span>
        </button>
        {onRemove && (
          <button
            type="button"
            aria-label={t("Remove {name}", { name: file.name })}
            onClick={onRemove}
          >
            <X size={12} />
          </button>
        )}
      </span>
      <Modal
        open={open}
        onOpenChange={setOpen}
        title={file.name}
        className="attachment-preview-modal"
      >
        {preview && <img src={preview} alt={file.name} />}
        <button className="text-button" type="button" onClick={download}>
          {t("Download file")}
        </button>
      </Modal>
    </>
  );
}
