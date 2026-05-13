// Streaming CSV parser. Yields one record (string[]) at a time.
// Handles quoted fields with embedded commas, double-quoted escapes, and \r\n line endings.
// Designed for Workers — never holds the whole file in memory.

export async function* parseCsvStream(stream) {
  const reader = stream.getReader();
  const decoder = new TextDecoder("utf-8");
  let buffer = "";

  while (true) {
    const { value, done } = await reader.read();
    if (done) {
      buffer += decoder.decode();
      break;
    }
    buffer += decoder.decode(value, { stream: true });

    // Parse complete records out of the buffer, leave any partial trailing
    // record behind for the next chunk.
    let i = 0;
    let lineStart = 0;
    while (i < buffer.length) {
      const consumed = consumeRecord(buffer, i);
      if (consumed === -1) break; // need more data
      yield parseRecord(buffer.slice(i, consumed.end));
      i = consumed.next;
      lineStart = i;
    }
    buffer = buffer.slice(lineStart);
  }

  // Flush remaining buffer.
  if (buffer.length && buffer.trim().length) {
    yield parseRecord(buffer);
  }
}

// Returns { end, next } where end is the index after the last char of the record
// (excluding line terminator) and next is the index of the first char of the next
// record. Returns -1 if the buffer ends mid-record (need more data).
function consumeRecord(s, start) {
  let inQuotes = false;
  for (let i = start; i < s.length; i++) {
    const c = s[i];
    if (inQuotes) {
      if (c === '"') {
        if (s[i + 1] === '"') i++; // escaped quote
        else inQuotes = false;
      }
    } else {
      if (c === '"') inQuotes = true;
      else if (c === "\n") return { end: s[i - 1] === "\r" ? i - 1 : i, next: i + 1 };
    }
  }
  return -1;
}

function parseRecord(line) {
  const out = [];
  let field = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (inQuotes) {
      if (c === '"') {
        if (line[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += c;
      }
    } else {
      if (c === '"') inQuotes = true;
      else if (c === ",") {
        out.push(field);
        field = "";
      } else field += c;
    }
  }
  out.push(field);
  return out;
}

// Convenience: iterate records as objects keyed by the header row.
export async function* parseCsvObjects(stream) {
  let headers = null;
  for await (const row of parseCsvStream(stream)) {
    if (!headers) {
      headers = row.map((h) => h.trim());
      continue;
    }
    const obj = {};
    for (let i = 0; i < headers.length; i++) obj[headers[i]] = row[i] ?? "";
    yield obj;
  }
}
