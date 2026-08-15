'use client';

import { CalendarDays, ChevronLeft, ChevronRight } from 'lucide-react';
import { parseDate, today, type CalendarDate } from '@internationalized/date';
import {
  Button,
  Calendar,
  CalendarCell,
  CalendarGrid,
  CalendarHeading,
  DateInput,
  DatePicker,
  DateSegment,
  Dialog,
  Group,
  I18nProvider,
  Label,
  Popover,
} from 'react-aria-components';

interface JournalDatePickerProps {
  value: string;
  onChange: (value: string) => void;
  disabled?: boolean;
}

function parseJournalDate(value: string): CalendarDate | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  try {
    return parseDate(value);
  } catch {
    return null;
  }
}

export default function JournalDatePicker({ value, onChange, disabled = false }: JournalDatePickerProps) {
  const selectedDate = parseJournalDate(value);

  return (
    <I18nProvider locale="zh-CN">
      <DatePicker
        className="journal-date-picker"
        value={selectedDate}
        onChange={nextValue => onChange(nextValue?.toString() ?? '')}
        granularity="day"
        isDisabled={disabled}
      >
        <Label className="journal-date-label">日期</Label>
        <Group className="journal-date-group">
          <DateInput className="journal-date-input">
            {segment => <DateSegment segment={segment} />}
          </DateInput>
          <Button className="journal-date-trigger" aria-label="打开日期选择器">
            <CalendarDays aria-hidden="true" />
          </Button>
        </Group>
        <Popover className="journal-date-popover" placement="bottom start" offset={8}>
          <Dialog className="journal-date-dialog">
            {({ close }) => (
              <>
                <Calendar className="journal-calendar">
                  <header className="journal-calendar-header">
                    <Button slot="previous" className="journal-calendar-nav" aria-label="上个月">
                      <ChevronLeft aria-hidden="true" />
                    </Button>
                    <CalendarHeading className="journal-calendar-heading" format={{ year: 'numeric', month: 'long' }} />
                    <Button slot="next" className="journal-calendar-nav" aria-label="下个月">
                      <ChevronRight aria-hidden="true" />
                    </Button>
                  </header>
                  <CalendarGrid className="journal-calendar-grid" weekdayStyle="short">
                    {date => <CalendarCell className="journal-calendar-cell" date={date} />}
                  </CalendarGrid>
                </Calendar>
                <div className="journal-calendar-actions">
                  <Button
                    className="journal-calendar-action journal-calendar-clear"
                    onPress={() => {
                      onChange('');
                      close();
                    }}
                  >
                    清除
                  </Button>
                  <Button
                    className="journal-calendar-action journal-calendar-today"
                    onPress={() => {
                      onChange(today('Asia/Shanghai').toString());
                      close();
                    }}
                  >
                    今天
                  </Button>
                </div>
              </>
            )}
          </Dialog>
        </Popover>
      </DatePicker>
    </I18nProvider>
  );
}
