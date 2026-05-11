export type GoogleCalendarCalendar = {
  accessRole?: string;
  id: string;
  primary: boolean;
  summary: string;
  timeZone?: string;
};

export type GoogleCalendarEventDateTime = {
  date?: string;
  dateTime?: string;
  timeZone?: string;
};

export type GoogleCalendarEventAttendee = {
  displayName?: string;
  email?: string;
  optional?: boolean;
  responseStatus?: string;
  self?: boolean;
};

export type GoogleCalendarEvent = {
  attendees: GoogleCalendarEventAttendee[];
  calendarId: string;
  description?: string;
  end: GoogleCalendarEventDateTime;
  eventId: string;
  htmlLink?: string;
  isAllDay: boolean;
  location?: string;
  organizerEmail?: string;
  start: GoogleCalendarEventDateTime;
  status?: string;
  summary?: string;
  updated?: string;
};

export type GoogleCalendarEventQuery = {
  calendarId?: string;
  limit?: number;
  query?: string;
  timeMax?: Date | string;
  timeMin?: Date | string;
};
