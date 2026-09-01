package com.impact.parser.workspace;

import java.nio.file.Path;
import java.util.List;

/**
 * Where the Java sources live inside one workspace.
 *
 * <p>The Node worker materialises a git worktree at a SHA and hands over its path
 * (DECISIONS D1); this service does no git and no network I/O of its own.
 *
 * @param root absolute path to the workspace
 * @param sourceRoots absolute paths to every discovered source root, sorted
 */
public record WorkspaceLayout(Path root, List<Path> sourceRoots) {

    /** Windows path separator, as a char constant to keep escaping out of the code below. */
    static final char WINDOWS_SEPARATOR = (char) 92;

    /**
     * Workspace-relative path with forward slashes.
     *
     * <p>Normalising separators is not cosmetic: {@code filePath} appears in
     * output that must be byte-identical across runs (section 8), and a Windows
     * parser emitting backslashes would produce different bytes from a Linux one
     * for the same commit.
     */
    public String relativize(Path file) {
        return root.relativize(file).toString().replace(WINDOWS_SEPARATOR, '/');
    }

    public List<String> relativeSourceRoots() {
        return sourceRoots.stream().map(this::relativize).toList();
    }
}
