import type { Dispatch, SetStateAction } from 'react';
import type { EditorStatusValue } from './editing-working-copy';
import type { JournalTimeValue } from './journal-time-payload';

type StringSetter = Dispatch<SetStateAction<string>>;
type StringListSetter = Dispatch<SetStateAction<string[]>>;

export type WorkingCopyEditorBindings = {
  setTitle: StringSetter;
  setSummary: StringSetter;
  setSlug: StringSetter;
  setCategories: StringListSetter;
  setTags: StringListSetter;
  setStatus: Dispatch<SetStateAction<EditorStatusValue>>;
  setKind: StringSetter;
  setDate: StringSetter;
  setJournalTime: Dispatch<SetStateAction<JournalTimeValue>>;
};
