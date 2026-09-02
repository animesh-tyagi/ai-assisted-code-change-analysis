package com.impact.parser.workspace;

import java.nio.file.Path;
import java.util.List;

/**
 * Where the Java sources live inside one workspace.
 *
 * <p>The Node worker materialises a git worktree at a SHA and hands over its path
 * (DECISIONS D1); this service does no git and no network I/O of its own.
 *
 * <p><strong>Two root sets, and the difference matters.</strong>
 * {@code solverRoots} is a superset of {@code extractionRoots}: everything the
 * type solver may read, versus the subset we actually turn into nodes.
 *
 * <p>Generated sources are why. petclinic-rest generates its DTOs into
 * {@code target/generated-sources/openapi/src/main/java}. Indexing them produces
 * nodes for code that is not in git, whose keys shift whenever the generator
 * runs — but <em>excluding them from the solver</em> means hand-written code that
 * legitimately depends on {@code OwnerDto} can no longer resolve it, and those
 * calls degrade to {@code unresolved:}. Feeding them to the solver while keeping
 * them out of extraction gets both: real resolution, no phantom nodes.
 *
 * @param root absolute path to the workspace
 * @param extractionRoots roots whose files become nodes and edges, sorted
 * @param solverRoots roots the type solver reads, sorted; always a superset
 */
public record WorkspaceLayout(Path root, List<Path> extractionRoots, List<Path> solverRoots) {

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

    public List<String> relativeExtractionRoots() {
        return extractionRoots.stream().map(this::relativize).toList();
    }

    public List<String> relativeSolverRoots() {
        return solverRoots.stream().map(this::relativize).toList();
    }

    /** Roots the solver reads but which produce no nodes — generated sources. */
    public List<String> relativeSolverOnlyRoots() {
        return solverRoots.stream()
                .filter(root -> !extractionRoots.contains(root))
                .map(this::relativize)
                .toList();
    }
}
