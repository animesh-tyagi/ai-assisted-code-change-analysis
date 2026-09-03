package com.impact.parser.workspace;

import java.io.IOException;
import java.io.UncheckedIOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.List;
import java.util.stream.Stream;

/**
 * Finds the Java source roots in a workspace, split by what they are for.
 *
 * <p>Discovers every {@code **}{@code /src/main/java} directory rather than
 * assuming one at the top. That covers multi-module builds for free: each root
 * gets its own {@code JavaParserTypeSolver}, so cross-module calls resolve. Both
 * current validation repos are single-module, where this is simply a no-op
 * generalisation (BUILD_PLAN Step 0, Q3).
 *
 * <p>Roots found <em>under a build-output directory</em> are handed to the solver
 * but not to extraction — see {@link WorkspaceLayout} for why generated sources
 * need to resolve without becoming nodes.
 *
 * <p>Test sources are excluded by default (Q2). Including them is a per-request
 * option so that "which tests cover this change" stays available later without a
 * change to the contract.
 */
public final class SourceRootDiscovery {

    private static final String MAIN_JAVA = "src/main/java";
    private static final String TEST_JAVA = "src/test/java";

    /**
     * Directories that hold build output rather than hand-written source.
     *
     * <p>A source root under one of these is generated: it resolves, but it is not
     * in git, and its node keys would shift every time the generator runs.
     */
    private static final List<String> BUILD_OUTPUT_DIRS =
            List.of("target", "build", "out", "bin", "node_modules", ".git", ".gradle", ".mvn");

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
        Path normalised = workspaceRoot.toAbsolutePath().normalize();

        List<Path> extractionRoots = new ArrayList<>();
        List<Path> solverRoots = new ArrayList<>();

        for (Path dir : allDirectories(normalised)) {
            String relative = relativeOf(normalised, dir);
            if (!isSourceRoot(relative, includeTestSources)) {
                continue;
            }
            solverRoots.add(dir);
            if (!isUnderBuildOutput(relative)) {
                extractionRoots.add(dir);
            }
        }

        if (extractionRoots.isEmpty()) {
            throw new NoSourceRootsException(normalised);
        }

        // Sorted so the solver is constructed identically every run — filesystem
        // walk order is not guaranteed and would otherwise leak nondeterminism
        // into resolution itself.
        extractionRoots.sort(Comparator.comparing(Path::toString));
        solverRoots.sort(Comparator.comparing(Path::toString));
        return new WorkspaceLayout(normalised, List.copyOf(extractionRoots), List.copyOf(solverRoots));
    }

    private static List<Path> allDirectories(Path workspaceRoot) {
        try (Stream<Path> walk = Files.walk(workspaceRoot)) {
            return walk.filter(Files::isDirectory).toList();
        } catch (IOException e) {
            throw new UncheckedIOException("failed to scan " + workspaceRoot, e);
        }
    }

    private static String relativeOf(Path workspaceRoot, Path dir) {
        return workspaceRoot.relativize(dir).toString().replace(WorkspaceLayout.WINDOWS_SEPARATOR, '/');
    }

    private static boolean isSourceRoot(String relative, boolean includeTestSources) {
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

    /**
     * Every {@code .java} file that should become nodes and edges.
     *
     * <p>Reads {@code extractionRoots} only: generated sources resolve but are
     * never extracted.
     */
    public static List<Path> javaFiles(WorkspaceLayout layout) {
        return layout.extractionRoots().stream()
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
