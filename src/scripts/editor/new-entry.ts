import { entrySectionIds, entrySectionInfo, isEntrySection, type EntrySection } from '../../lib/entry-sections.mjs';
import { button, node, openDialog } from './ui';

/** Owner controls and the writer use the same explicit destination choice. */
export function chooseEntryDestination(initial?: EntrySection): Promise<EntrySection | undefined> {
  const { promise, resolve } = Promise.withResolvers<EntrySection | undefined>();
  const { dialog, body, footer } = openDialog('New entry');
  body.append(node('p', 'Choose where this entry belongs. Every destination has the same text, pictures, video, audio and publishing tools.', 'owner-hint'));
  const field = node('label', undefined, 'owner-label');
  const select = node('select', undefined, 'owner-field');
  const placeholder = node('option', 'Choose a destination');
  placeholder.value = '';
  placeholder.disabled = true;
  select.append(placeholder);
  for (const section of entrySectionIds) {
    const option = node('option', entrySectionInfo[section].label);
    option.value = section;
    select.append(option);
  }
  select.value = initial ?? '';
  field.append(node('span', 'Destination'), select);
  body.append(field);
  let selected: EntrySection | undefined;
  const create = button('Start writing', () => {
    if (!isEntrySection(select.value)) return;
    selected = select.value;
    dialog.close();
  }, 'owner-button owner-button--primary');
  create.disabled = !isEntrySection(select.value);
  select.addEventListener('change', () => { create.disabled = !isEntrySection(select.value); });
  footer.append(button('Cancel', () => dialog.close()), create);
  dialog.addEventListener('close', () => resolve(selected), { once: true });
  select.focus();
  return promise;
}
