package com.impact.parser.cli;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.SerializationFeature;
import com.impact.parser.api.ParseResponse;
import com.impact.parser.api.ParseResponseMapper;
import com.impact.parser.extract.ExtractionResult;
import com.impact.parser.extract.GraphExtractor;
import com.impact.parser.resolve.SourceAndJdkTypeSolverFactory;
import com.impact.parser.workspace.SourceRootDiscovery;
import com.impact.parser.workspace.WorkspaceLayout;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * Point the parser at a directory and dump the §8 JSON.
 *
 * <p>BUILD_PLAN Step 2 puts this deliberately <em>before</em> the HTTP layer: the
 * edges want eyeballing on code the author knows before anything is built on top
 * of them. A wrong graph behind a correct-looking API is the expensive failure,
 * and no amount of endpoint testing finds it.
 *
 * <p>It shares {@link ParseResponseMapper} with the HTTP endpoint, so what you
 * inspect here is byte-for-byte what the worker will receive.
 *
 * <pre>
 * mvn -q compile exec:java -Dexec.mainClass=com.impact.parser.ParserApplication \
 *     -Dexec.args="--dir /path/to/repo"
 *
 * java -jar target/parser-0.1.0.jar --dir /path/to/repo [options]
 *
 *   --dir &lt;path&gt;        workspace to parse (required)
 *   --sha &lt;sha&gt;         recorded in the response; defaults to "working-tree"
 *   --files a.java,b    subset mode — extract only these (workspace-relative)
 *   --include-tests     also extract src/test/java (excluded by default, Q2)
 *   --out &lt;path&gt;        write JSON here instead of stdout
 *   --summary           print a human-readable digest instead of JSON
 * </pre>
 */
public final class ParseCommand {

    /** The flag that switches the application from web service to one-shot CLI. */
    public static final String DIR_FLAG = "--dir";

    /**
     * Every flag this CLI owns.
     *
     * <p>Detection covers all of them, not just {@code --dir}. Matching only
     * {@code --dir} meant that {@code --summary} on its own fell through and booted
     * the web server: the process bound a port and blocked instead of printing a
     * usage error, which reads as a hang. Spring Boot's own {@code --server.port=…}
     * style arguments are untouched, since they are not in this set.
     */
    private static final java.util.Set<String> CLI_FLAGS =
            java.util.Set.of("--dir", "--sha", "--files", "--include-tests", "--out", "--summary");

    private ParseCommand() {}

    public static boolean isCliInvocation(String[] args) {
        for (String arg : args) {
            if (CLI_FLAGS.contains(arg)) {
                return true;
            }
        }
        return false;
    }

    /**
     * stdout and stderr as UTF-8, regardless of the console's default.
     *
     * <p>Windows consoles default to a legacy code page, which mangles any
     * non-ASCII byte on the way out. For a tool whose output is piped to a file
     * and compared byte-for-byte, that is corruption, not a display quirk — so the
     * streams are pinned rather than trusted.
     */
    private static java.io.PrintStream utf8(java.io.OutputStream stream) {
        return new java.io.PrintStream(stream, true, StandardCharsets.UTF_8);
    }

    /** @return process exit code: 0 on success, 2 on a usage or workspace error */
    public static int run(String[] args) {
        java.io.PrintStream out = utf8(new java.io.FileOutputStream(java.io.FileDescriptor.out));
        java.io.PrintStream err = utf8(new java.io.FileOutputStream(java.io.FileDescriptor.err));
        Map<String, String> options;
        try {
            options = parse(args);
        } catch (IllegalArgumentException e) {
            err.println("error: " + e.getMessage());
            err.println("usage: --dir <path> [--sha <sha>] [--files a,b] [--include-tests] [--out <path>] [--summary]");
            return 2;
        }

        Path workspace = Path.of(options.get("dir")).toAbsolutePath().normalize();
        boolean includeTests = options.containsKey("include-tests");
        String sha = options.getOrDefault("sha", "working-tree");

        WorkspaceLayout layout;
        try {
            layout = SourceRootDiscovery.discover(workspace, includeTests);
        } catch (SourceRootDiscovery.NoSourceRootsException | IllegalArgumentException e) {
            // The same condition §8 reports as 422 over HTTP.
            err.println("error: " + e.getMessage());
            return 2;
        }

        List<Path> files;
        String mode;
        if (options.containsKey("files")) {
            mode = "subset";
            files = new ArrayList<>();
            for (String relative : options.get("files").split(",")) {
                String trimmed = relative.trim();
                if (!trimmed.isEmpty()) {
                    files.add(workspace.resolve(trimmed).toAbsolutePath().normalize());
                }
            }
        } else {
            mode = "full";
            files = SourceRootDiscovery.javaFiles(layout);
        }

        long start = System.currentTimeMillis();
        ExtractionResult result =
                new GraphExtractor(new SourceAndJdkTypeSolverFactory().create(layout))
                        .extract(layout, files);
        long durationMs = System.currentTimeMillis() - start;

        ParseResponse response =
                ParseResponseMapper.toResponse("cli", sha, mode, layout, result, durationMs);

        if (options.containsKey("summary")) {
            printSummary(out, layout, result, durationMs);
            return 0;
        }

        try {
            String json = writer().writeValueAsString(response);
            if (options.containsKey("out")) {
                Path outFile = Path.of(options.get("out")).toAbsolutePath().normalize();
                Files.writeString(outFile, json, StandardCharsets.UTF_8);
                err.println("wrote " + outFile);
            } else {
                out.println(json);
            }
            return 0;
        } catch (IOException e) {
            err.println("error: could not write output: " + e.getMessage());
            return 2;
        }
    }

    private static ObjectMapper writer() {
        // INDENT_ORDER is off by default and stays off: field order comes from the
        // record's declaration, which is stable, and lists are already sorted by
        // extraction. Pretty-printing is for reading; it does not reorder anything,
        // so the same commit still serialises identically.
        return new ObjectMapper().enable(SerializationFeature.INDENT_OUTPUT);
    }

    /**
     * A digest for eyeballing, which is the whole point of this phase.
     *
     * <p>Leads with the health signal rather than the raw counts: a big graph that
     * is quietly 30% blind is worse than a small correct one.
     */
    private static void printSummary(
            java.io.PrintStream out,
            WorkspaceLayout layout,
            ExtractionResult result,
            long durationMs) {
        out.printf("workspace         : %s%n", layout.root());
        out.printf("extraction roots  : %s%n", layout.relativeExtractionRoots());
        List<String> solverOnly = layout.relativeSolverOnlyRoots();
        if (!solverOnly.isEmpty()) {
            out.printf("solver-only roots : %s  (resolved, not extracted)%n", solverOnly);
        }
        out.printf("files parsed      : %d%n", result.filesParsed());
        out.printf("functions         : %d%n", result.functions().size());
        out.printf("surfaces          : %d%n", result.surfaces().size());
        out.printf("edges             : %d%n", result.edges().size());

        Map<String, Integer> byType = new LinkedHashMap<>();
        result.edges().forEach(e -> byType.merge(e.type().wireName(), 1, Integer::sum));
        byType.forEach((type, count) -> out.printf("  %-12s %d%n", type, count));

        Map<String, Integer> bySurface = new LinkedHashMap<>();
        result.surfaces().forEach(s -> bySurface.merge(s.kind().wireName(), 1, Integer::sum));
        bySurface.forEach((kind, count) -> out.printf("  %-12s %d%n", kind, count));

        out.printf(
                "%nnonExternalUnresolvedRate : %.2f%%   <-- the health signal (§6.5)%n",
                result.nonExternalUnresolvedRate() * 100);
        out.printf(
                "unresolvedRate            : %.2f%%   (diagnostic; D2 upgrade trigger)%n",
                result.unresolvedRate() * 100);
        out.printf("externalCalls             : %d   (resolved, out of scope)%n", result.externalCalls());
        out.printf("parse errors              : %d%n", result.parseErrors().size());
        result.parseErrors().forEach(e -> out.printf("  %s: %s%n", e.filePath(), e.message()));
        out.printf("duration                  : %d ms%n", durationMs);
    }

    /** Minimal flag parsing — no dependency, and the surface is tiny. */
    private static Map<String, String> parse(String[] args) {
        Map<String, String> options = new LinkedHashMap<>();
        for (int i = 0; i < args.length; i++) {
            String arg = args[i];
            if (!arg.startsWith("--")) {
                throw new IllegalArgumentException("unexpected argument: " + arg);
            }
            String name = arg.substring(2);
            boolean isFlag = name.equals("include-tests") || name.equals("summary");
            if (isFlag) {
                options.put(name, "true");
                continue;
            }
            if (i + 1 >= args.length) {
                throw new IllegalArgumentException("missing value for " + arg);
            }
            options.put(name, args[++i]);
        }
        if (!options.containsKey("dir")) {
            throw new IllegalArgumentException("--dir is required");
        }
        return options;
    }
}
