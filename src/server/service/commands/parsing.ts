export type FrontMatterValue = string | string[] | number | boolean | undefined;
export type FrontMatter = Record<string, FrontMatterValue>;

const parseInlineArray = (raw: string): string[] => {
  const trimmed = raw.trim().replace(/^\[|\]$/g, "");
  if (trimmed.length === 0) return [];
  return trimmed
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0)
    .map((entry) => entry.replace(/^['"]|['"]$/g, ""));
};

export const parseFrontMatter = (raw: string): FrontMatter => {
  const lines = raw.split(/\r?\n/);
  const result: FrontMatter = {};
  let currentKey: string | null = null;
  let currentArray: string[] | null = null;

  const assignValue = (
    key: string,
    value: string | string[] | number | boolean,
  ) => {
    result[key] = value;
    if (Array.isArray(value)) {
      currentArray = value;
      currentKey = key;
    } else {
      currentArray = null;
      currentKey = null;
    }
  };

  for (const originalLine of lines) {
    const line = originalLine.trim();
    if (line.length === 0 || line.startsWith("#")) {
      continue;
    }

    if (line.startsWith("- ") && Array.isArray(currentArray) && currentKey) {
      const value = line.slice(2).trim();
      if (value.length > 0) {
        (currentArray as string[]).push(value.replace(/^['"]|['"]$/g, ""));
      }
      continue;
    }

    const colonIndex = line.indexOf(":");
    if (colonIndex === -1) {
      continue;
    }

    const key = line.slice(0, colonIndex).trim();
    const value = line.slice(colonIndex + 1).trim();

    if (value.length === 0) {
      assignValue(key, []);
      continue;
    }

    if (value.startsWith("[")) {
      assignValue(key, parseInlineArray(value));
      continue;
    }

    if (value === "true" || value === "false") {
      assignValue(key, value === "true");
      continue;
    }

    const numeric = Number(value);
    if (!Number.isNaN(numeric) && value === numeric.toString()) {
      assignValue(key, numeric);
      continue;
    }

    assignValue(key, value.replace(/^['"]|['"]$/g, ""));
  }

  return result;
};

export const extractFrontMatter = (
  input: string,
): {
  frontMatter: FrontMatter;
  body: string;
} => {
  if (!input.startsWith("---")) {
    return { frontMatter: {}, body: input };
  }

  const endIndex = input.indexOf("\n---", 3);
  if (endIndex === -1) {
    return { frontMatter: {}, body: input };
  }

  const fmBlock = input.slice(3, endIndex);
  const rest = input.slice(endIndex + 4);
  return {
    frontMatter: parseFrontMatter(fmBlock),
    body: rest,
  };
};

export const normalizeStringArray = (value: unknown): string[] | undefined => {
  if (!Array.isArray(value)) return undefined;
  const unique = Array.from(
    new Set(
      value
        .map((entry) =>
          typeof entry === "string" ? entry.trim() : JSON.stringify(entry),
        )
        .filter((entry) => entry.length > 0),
    ),
  );
  return unique.length > 0 ? unique : undefined;
};

export const resolveDescription = (
  frontMatter: FrontMatter,
  body: string,
): string | undefined => {
  const description = frontMatter["description"];
  if (typeof description === "string" && description.trim().length > 0) {
    return description.trim();
  }

  const headingMatch = body.match(/^#\s+(.+)$/m);
  if (headingMatch?.[1]) {
    return headingMatch[1].trim();
  }

  const firstLine = body
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line.length > 0);

  return firstLine?.trim();
};

export const extractOrderHint = (
  frontMatter: FrontMatter,
): number | undefined => {
  const orderRaw = frontMatter["order"];
  if (typeof orderRaw === "number" && Number.isFinite(orderRaw)) {
    return orderRaw;
  }

  if (typeof orderRaw === "string") {
    const parsed = Number(orderRaw);
    if (!Number.isNaN(parsed)) {
      return parsed;
    }
  }

  return undefined;
};
