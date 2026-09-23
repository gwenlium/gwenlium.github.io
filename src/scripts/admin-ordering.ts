import CMS from 'decap-cms-app';
import { createElement as h, type ChangeEvent, type Component, type ReactNode } from 'react';
import '../styles/admin.css';

type ImmutableValues = {
  toArray(): unknown[];
  clear(): ImmutableValues;
  concat(values: unknown[]): ImmutableValues;
};
type OrderingProps = {
  value: unknown;
  field: { get(key: string, fallback?: unknown): unknown };
  onChange(value: unknown): void;
  forID: string;
};
type OrderingState = {
  orderIndex: number;
  orderStatus: string;
  keys?: string[];
  itemsCollapsed?: boolean[];
  [key: string]: unknown;
};
type NativeControl = new (props: OrderingProps) => Component<OrderingProps, OrderingState>;
type NativeWidget = {
  control: NativeControl;
  preview?: unknown;
  schema?: { properties?: Record<string, unknown>; [key: string]: unknown };
  globalStyles?: unknown;
  allowMapValue?: boolean;
};

const names = new Intl.Collator('en', { numeric: true, sensitivity: 'base' });

function isImmutableValues(value: unknown): value is ImmutableValues {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Partial<ImmutableValues>;
  return typeof candidate.toArray === 'function' && typeof candidate.clear === 'function' && typeof candidate.concat === 'function';
}

function values(value: unknown): unknown[] {
  return Array.isArray(value) ? value : isImmutableValues(value) ? value.toArray() : [];
}

function itemLabel(item: unknown): string {
  let label = item;
  if (item && typeof item === 'object') {
    const record = item as { get?: (key: string) => unknown; [key: string]: unknown };
    for (const key of ['title', 'alt', 'caption', 'src']) {
      const candidate = typeof record.get === 'function' ? record.get(key) : record[key];
      if (typeof candidate === 'string' && candidate.trim()) { label = candidate; break; }
    }
  }
  if (typeof label !== 'string' || !label.trim()) return 'Untitled media';
  let text = label;
  if (text.startsWith('/') || /^https?:\/\//.test(text)) {
    text = text.split('/').pop() || text;
    try { text = decodeURIComponent(text); } catch { /* Keep authored filenames with malformed escapes readable. */ }
  }
  return text.replace(/\s+/g, ' ').trim();
}

function withOrdering(Control: NativeControl): NativeControl {
  return class OrderedMediaControl extends Control {
    constructor(props: OrderingProps) {
      super(props);
      this.state = { ...this.state, orderIndex: 0, orderStatus: '' };
    }

    override shouldComponentUpdate(nextProps: Readonly<OrderingProps>, nextState: Readonly<OrderingState>): boolean {
      return nextState !== this.state || super.shouldComponentUpdate?.(nextProps, nextState, this.context) !== false;
    }

    private applyOrder(order: number[], message: string) {
      const items = values(this.props.value);
      if (items.length < 2) return;
      if (order.every((index, position) => index === position)) {
        this.setState({ orderStatus: 'Already in this order.' });
        return;
      }
      const selected = Math.min(this.state.orderIndex, items.length - 1);
      const reordered = order.map(index => items[index]);
      const state: OrderingState = { ...this.state, orderIndex: order.indexOf(selected), orderStatus: `${message} Save the entry to publish this order.` };
      // Decap list controls associate nested editors and validation with these keys.
      // Move that state with the complete items, just as the native drag handler does.
      if (this.state.keys) state.keys = order.map(index => this.state.keys![index]);
      if (this.state.itemsCollapsed) state.itemsCollapsed = order.map(index => this.state.itemsCollapsed![index]);
      const nextValue = isImmutableValues(this.props.value) ? this.props.value.clear().concat(reordered) : reordered;
      this.props.onChange(nextValue);
      this.setState(state);
    }

    private move(target: number) {
      const items = values(this.props.value);
      const index = Math.min(this.state.orderIndex, items.length - 1);
      if (target < 0 || target >= items.length || target === index) return;
      const order = items.map((_, position) => position);
      order.splice(target, 0, order.splice(index, 1)[0]);
      this.applyOrder(order, `Moved item ${index + 1} to position ${target + 1}.`);
    }

    private sort(direction: 1 | -1) {
      const items = values(this.props.value);
      const labels = items.map(itemLabel);
      const order = items.map((_, index) => index).sort((a, b) => direction * names.compare(labels[a], labels[b]) || a - b);
      this.applyOrder(order, `Sorted ${direction === 1 ? 'A-Z' : 'Z-A'}.`);
    }

    override render(): ReactNode {
      const control = super.render();
      if (this.props.field.get('media_ordering') !== true || this.props.field.get('allow_reorder', true) === false) return control;
      const items = values(this.props.value);
      const index = Math.max(0, Math.min(this.state.orderIndex, items.length - 1));
      const label = String(this.props.field.get('label') || this.props.field.get('name') || 'Media');
      const selectId = `${this.props.forID}-order`;
      const button = (text: string, action: () => void, disabled: boolean) => h('button', {
        type: 'button', onClick: action, disabled, 'aria-label': `${label}: ${text}`,
      }, text);
      return h('div', { className: 'admin-ordered-media' },
        h('div', { className: 'admin-ordering', role: 'group', 'aria-label': `${label} order` },
          h('label', { htmlFor: selectId }, 'Item to move'),
          h('select', {
            id: selectId, value: items.length ? String(index) : '', disabled: items.length < 2,
            onChange: (event: ChangeEvent<HTMLSelectElement>) => this.setState({ orderIndex: Number(event.currentTarget.value), orderStatus: '' }),
          }, items.length ? items.map((item, position) => h('option', { key: position, value: String(position) }, `${position + 1}. ${itemLabel(item)}`)) : h('option', { value: '' }, 'No media yet')),
          h('div', { className: 'admin-ordering-actions' },
            button('Move first', () => this.move(0), items.length < 2 || index === 0),
            button('Move earlier', () => this.move(index - 1), items.length < 2 || index === 0),
            button('Move later', () => this.move(index + 1), items.length < 2 || index === items.length - 1),
            button('Move last', () => this.move(items.length - 1), items.length < 2 || index === items.length - 1),
          ),
          h('div', { className: 'admin-ordering-actions' },
            button('Sort A-Z', () => this.sort(1), items.length < 2),
            button('Sort Z-A', () => this.sort(-1), items.length < 2),
            button('Reverse order', () => this.applyOrder(items.map((_, position) => position).reverse(), 'Reversed order.'), items.length < 2),
          ),
          h('p', { className: 'admin-ordering-help' }, 'Sort by title or description; unlabeled pictures use filenames. Dragging below still works.'),
          h('p', { role: 'status', 'aria-live': 'polite', 'aria-atomic': true }, this.state.orderStatus),
        ),
        control,
      );
    }
  };
}

export function registerMediaOrdering(): void {
  for (const name of ['image', 'list']) {
    // Preserve native media insertion, nested-field editing and preview behavior.
    const native = CMS.getWidget(name) as unknown as NativeWidget;
    const registration = {
      name,
      controlComponent: withOrdering(native.control),
      previewComponent: native.preview,
      schema: { ...native.schema, properties: { ...native.schema?.properties, media_ordering: { type: 'boolean' } } },
      globalStyles: native.globalStyles,
      allowMapValue: native.allowMapValue,
    };
    // Decap's declaration types controlComponent as props rather than a component.
    CMS.registerWidget(registration as unknown as Parameters<typeof CMS.registerWidget>[0]);
  }
}
