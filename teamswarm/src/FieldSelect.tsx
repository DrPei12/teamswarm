import {
  Children,
  isValidElement,
  useId,
  useState,
  type ReactNode,
} from "react";
import { Select } from "radix-ui";
import { Check, ChevronDown } from "lucide-react";

/** Form select using the same anchored menu and keyboard behavior as the composer. */
export function FieldSelect({
  value,
  defaultValue,
  onValueChange,
  children,
  disabled,
  name,
  id,
  required,
  className = "",
  "aria-label": label,
}: {
  value?: string;
  defaultValue?: string;
  onValueChange?: (value: string) => void;
  children: ReactNode;
  disabled?: boolean;
  name?: string;
  id?: string;
  required?: boolean;
  className?: string;
  "aria-label"?: string;
}) {
  const uid = useId();
  const empty = `${uid}-empty`;
  const [local, setLocal] = useState(defaultValue ?? "");
  const options = Children.toArray(children).filter(
    isValidElement<{ value: string; disabled?: boolean; children: ReactNode }>,
  );
  const placeholder = options.find((option) => !option.props.value)?.props
    .children;
  const selection = value ?? local;
  const matched = options.some((option) => option.props.value === selection);
  return (
    <Select.Root
      value={selection}
      onValueChange={(v) => {
        const next = v === empty ? "" : v;
        setLocal(next);
        onValueChange?.(next);
      }}
      disabled={disabled}
      name={name}
      required={required}
    >
      <Select.Trigger
        id={id}
        className={`field-select ${className}`}
        aria-label={label}
      >
        <Select.Value placeholder={placeholder}>
          {selection && !matched ? selection : undefined}
        </Select.Value>
        <Select.Icon>
          <ChevronDown size={16} />
        </Select.Icon>
      </Select.Trigger>
      <Select.Portal>
        <Select.Content
          className="menu field-select-menu"
          position="popper"
          sideOffset={5}
          collisionPadding={10}
        >
          <Select.Viewport>
            {Children.toArray(children).map((child) => {
              if (
                !isValidElement<{
                  value: string;
                  disabled?: boolean;
                  children: ReactNode;
                }>(child)
              )
                return null;
              return (
                <Select.Item
                  key={child.props.value || empty}
                  value={child.props.value || empty}
                  disabled={child.props.disabled}
                  className="field-select-option"
                >
                  <Select.ItemText>{child.props.children}</Select.ItemText>
                  <Select.ItemIndicator>
                    <Check size={15} />
                  </Select.ItemIndicator>
                </Select.Item>
              );
            })}
          </Select.Viewport>
        </Select.Content>
      </Select.Portal>
    </Select.Root>
  );
}
