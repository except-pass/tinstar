/**
 * Generate synthetic git diff from old and new string content
 * This creates a git diff format string that can be parsed by parse-git-diff
 */
export function generateSyntheticGitDiff(
  filePath: string,
  oldContent: string,
  newContent: string,
): string {
  const oldLines = oldContent.split("\n");
  const newLines = newContent.split("\n");

  // Generate unified diff format
  const diffLines: string[] = [];

  // Git diff header
  diffLines.push(`diff --git a/${filePath} b/${filePath}`);
  diffLines.push(`--- a/${filePath}`);
  diffLines.push(`+++ b/${filePath}`);

  // Simple implementation: treat entire content as one hunk
  // This could be optimized with proper LCS algorithm for better hunks
  const hunkHeader = `@@ -1,${oldLines.length} +1,${newLines.length} @@`;
  diffLines.push(hunkHeader);

  // Add removed lines
  for (const line of oldLines) {
    diffLines.push(`-${line}`);
  }

  // Add added lines
  for (const line of newLines) {
    diffLines.push(`+${line}`);
  }

  return diffLines.join("\n");
}

/**
 * Apply multiple edits sequentially to generate cumulative diff
 * For MultiEdit tools with multiple old_string/new_string pairs
 */
export function generateMultiEditDiff(
  filePath: string,
  edits: Array<{ old_string: string; new_string: string }>,
): string {
  let currentContent = "";

  // Start with the first edit's old_string as the base
  if (edits.length > 0 && edits[0]) {
    currentContent = edits[0].old_string;
  }

  // Apply each edit sequentially
  for (const edit of edits) {
    currentContent = currentContent.replace(edit.old_string, edit.new_string);
  }

  // Generate diff from original to final state
  const originalContent =
    edits.length > 0 && edits[0] ? edits[0].old_string : "";
  return generateSyntheticGitDiff(filePath, originalContent, currentContent);
}
