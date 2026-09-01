package com.impact.parser.workspace;

import java.io.IOException;
import java.io.UncheckedIOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.Comparator;
import java.util.List;
import java.util.stream.Stream;

/**
 * Finds the Java source roots in a workspace.
 *
 * <p>Discovers every {@code **}{@code /src/main/java} directory rather than
 * assuming one at the top. That covers multi-module builds for free: each root
 * gets its own {@code JavaParserTypeSolver}, so cross-module calls resolve. Both
 * current validation repos are single-module, where this is simply a no-op
 * generalisation (BUILD_PLAN Step 0, Q3).
 *
 * <p>Test sources are excluded by default (Q2). Including them is a per-request
 * option so that "which tests cover this change" stays available later without a
 * change to the contract.
 */
public final class SourceRootDiscovery {

    private static final String MAIN_JAVA = "src/main/java";
    private static final String TEST_JAVA = "src/test/java";

    private SourceRootDiscovery() {}

    /** Thrown when a workspace contains no Java source roots — a 422 in section 8. */
    public static class NoSourceRootsException extends RuntimeException {
        public NoSourceRootsException(Path root) {
            super("no Java source roots found under " + root);
        }
    }

    public static WorkspaceLayout discover(Path workspaceRoot, boolean includeTestSources) {
        if (!Files.isDirectory(workspaceRoot)) {
            throw new IllegalArgumentException("workspace path is not a directory: " + workspaceRoot);
        }

        List<Path> roots = findRoots(workspaceRoot, includeTestSources);
        if (roots.isEmpty()) {
            throw new NoSourceRootsException(workspaceRoot);
        }
        return new WorkspaceLayout(workspaceRoot.toAbsolutePath().normalize(), roots);
    }

    private static List<Path> findRoots(Path workspaceRoot, boolean includeTestSources) {
        Path normalised = workspaceRoot.toAbsolutePath().normalize();
        try (Stream<Path> walk = Files.walk(normalised)) {
            return walk.filter(Files::isDirectory)
                    .filter(dir -> matchesSourceRoot(normalised, dir, includeTestSources))
                    // Sorted so the solver is constructed identically every run —
                    // filesystem walk order is not guaranteed and would otherwise
                    // leak nondeterminism into resolution.
                    .sorted(Comparator.comparing(Path::toString))
                    .toList();
        } catch (IOException e) {
            throw new UncheckedIOException("failed to scan " + normalised, e);
        }
    }

    /**
     * Directories that hold build output rather than source.
     *
     * <p>Skipping these is not tidiness. petclinic-rest generates OpenAPI
     * interfaces into {@code target/generated-sources/openapi/src/main/java},
     * which matches the source-root pattern exactly — so without this the parser
     * indexed generated code that is not in git, inflating the graph with nodes
     * no commit can ever change and no reviewer would recognise.
     */
    private static final List<String> BUILD_OUTPUT_DIRS =
            List.of("target", "build", "out", "bin", "node_modules", ".git", ".gradle", ".mvn");

    private static boolean matchesSourceRoot(Path workspaceRoot, Path dir, boolean includeTestSources) {
        String relative =
                workspaceRoot.relativize(dir).toString().replace(WorkspaceLayout.WINDOWS_SEPARATOR, '/');
        if (isUnderBuildOutput(relative)) {
            return false;
        }
        if (relative.equals(MAIN_JAVA) || relative.endsWith("/" + MAIN_JAVA)) {
            return true;
        }
        return includeTestSources && (relative.equals(TEST_JAVA) || relative.endsWith("/" + TEST_JAVA));
    }

    private static boolean isUnderBuildOutput(String relativePath) {
        for (String segment : relativePath.split("/")) {
            if (BUILD_OUTPUT_DIRS.contains(segment)) {
                return true;
            }
        }
        return false;
    }

    /** Every {@code .java} file under the given roots, sorted for determinism. */
    public static List<Path> javaFiles(WorkspaceLayout layout) {
        return layout.sourceRoots().stream()
                .flatMap(SourceRootDiscovery::walkJavaFiles)
                .distinct()
                .sorted(Comparator.comparing(Path::toString))
                .toList();
    }

    private static Stream<Path> walkJavaFiles(Path root) {
        try (Stream<Path> walk = Files.walk(root)) {
            return walk.filter(Files::isRegularFile)
                    .filter(p -> p.getFileName().toString().endsWith(".java"))
                    .toList()
                    .stream();
        } catch (IOException e) {
            throw new UncheckedIOException("failed to scan source root " + root, e);
        }
    }
}
