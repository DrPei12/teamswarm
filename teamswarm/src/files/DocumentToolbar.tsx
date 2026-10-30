import {
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Check,
  Minus,
  Plus,
} from "lucide-react";
import { DropdownMenu } from "radix-ui";
import { useI18n } from "../i18n";

export default function DocumentToolbar({
  page,
  pages,
  onPage,
  zoom,
  onZoom,
  onFit,
  slides = false,
}: {
  page: number;
  pages: number;
  onPage: (page: number) => void;
  zoom: number;
  onZoom: (zoom: number) => void;
  onFit?: () => void;
  slides?: boolean;
}) {
  const { t } = useI18n();
  const minimum = slides ? 0.1 : 0.5;
  return (
    <div className="document-toolbar">
      <div className="document-pagination">
        <button
          type="button"
          aria-label={t(slides ? "Previous slide" : "Previous page")}
          disabled={page <= 0}
          onClick={() => onPage(page - 1)}
        >
          <ChevronLeft size={15} />
        </button>
        <span aria-live="polite">
          {pages ? page + 1 : "—"}
          <span className="document-page-total"> / {pages || "—"}</span>
        </span>
        <button
          type="button"
          aria-label={t(slides ? "Next slide" : "Next page")}
          disabled={page + 1 >= pages}
          onClick={() => onPage(page + 1)}
        >
          <ChevronRight size={15} />
        </button>
      </div>
      <div className="document-zoom">
        <button
          type="button"
          aria-label={t("Zoom out")}
          disabled={zoom <= minimum}
          onClick={() => onZoom(Math.max(minimum, zoom - 0.25))}
        >
          <Minus size={14} />
        </button>
        <DropdownMenu.Root modal={false}>
          <DropdownMenu.Trigger
            className="document-zoom-value"
            aria-label={t("Document zoom")}
          >
            {Math.round(zoom * 100)}%<ChevronDown size={12} />
          </DropdownMenu.Trigger>
          <DropdownMenu.Portal>
            <DropdownMenu.Content
              className="document-zoom-menu"
              align="end"
              sideOffset={5}
            >
              <DropdownMenu.Item onSelect={onFit ?? (() => onZoom(1))}>
                {t("Fit width")}
              </DropdownMenu.Item>
              <DropdownMenu.Separator />
              {[0.5, 0.75, 1, 1.25, 1.5, 2].map((value) => (
                <DropdownMenu.Item key={value} onSelect={() => onZoom(value)}>
                  {Math.round(value * 100)}%
                  {zoom === value && <Check size={14} />}
                </DropdownMenu.Item>
              ))}
            </DropdownMenu.Content>
          </DropdownMenu.Portal>
        </DropdownMenu.Root>
        <button
          type="button"
          aria-label={t("Zoom in")}
          disabled={zoom >= 2}
          onClick={() => onZoom(Math.min(2, zoom + 0.25))}
        >
          <Plus size={14} />
        </button>
      </div>
    </div>
  );
}
