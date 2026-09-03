package com.impact.parser.snapshot;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.fail;

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
import java.io.UncheckedIOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardOpenOption;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

/**
 * Golden-master tests for §8's purity guarantee (BUILD_PLAN Step 2 phase 8).
 *
 * <p><strong>The whole {@link ParseResponse} is the golden master — diagnostics
 * included, not just {@code functions}/{@code surfaces}/{@code edges}.</strong>
 * A change that silently shifts {@code unresolvedRate} or {@code externalCalls}
 * while leaving the graph itself untouched is exactly the kind of regression a
 * snapshot exists to catch, and a snapshot that only compares the graph would
 * miss it entirely. The {@code springData} fixture exists specifically to give
 * diagnostics non-zero values to pin — a fixture that resolves everything would
 * leave every diagnostic field at a trivial zero, which proves nothing about
 * whether they stayed put.
 *
 * <p>Only {@code durationMs} is excluded: it is wall-clock and legitimately
 * varies run to run, which is precisely why it does not participate in §8's
 * purity claim in the first place (see {@link com.impact.parser.api.ParseDiagnostics}).
 *
 * <p><strong>Updating a snapshot is a reviewed, two-step action, never a silent
 * overwrite.</strong> Run with {@code -Dsnapshot.update=true}: the test writes
 * the new golden file and then <em>fails</em>, forcing a {@code git diff} review
 * of what changed before the next plain run is allowed to go green. A snapshot
 * that could update and pass in the same run would let a regression get
 * "confirmed" by the same command that introduced it.
 */
class ParserSnapshotTest {

    private static final String UPDATE_PROPERTY = "snapshot.update";

    /** Fixed inputs to the mapper so the golden file never varies for reasons unrelated to extraction. */
    private static final String REQUEST_ID = "snapshot";

    private static final String SHA = "0000000000000000000000000000000000000000";
    private static final String DURATION_PLACEHOLDER = "-1";

    @TempDir Path workspace;

    private ObjectMapper prettyWriter() {
        // Same style as the CLI (ParseCommand#writer): pretty-printed for a
        // reviewable diff, no reordering — field order is the record's
        // declaration order and every list already arrives sorted from
        // extraction, so pretty-printing changes nothing about what is compared.
        return new ObjectMapper().enable(SerializationFeature.INDENT_OUTPUT);
    }

    private String render(Path root) throws IOException {
        WorkspaceLayout layout = SourceRootDiscovery.discover(root, false);
        ExtractionResult result =
                new GraphExtractor(new SourceAndJdkTypeSolverFactory().create(layout))
                        .extract(layout, SourceRootDiscovery.javaFiles(layout));
        // durationMs is fixed at construction, not stripped by regex afterward —
        // avoids any risk of the normalisation pattern also matching a field it
        // was not meant to touch.
        ParseResponse response = ParseResponseMapper.toResponse(REQUEST_ID, SHA, "full", layout, result, -1);
        try {
            return prettyWriter().writeValueAsString(response) + System.lineSeparator();
        } catch (com.fasterxml.jackson.core.JsonProcessingException e) {
            throw new UncheckedIOException(new IOException(e));
        }
    }

    private void compareToGoldenMaster(String name, Path root) throws IOException {
        String actual = render(root);
        assertThat(actual).contains("\"durationMs\" : " + DURATION_PLACEHOLDER);

        Path golden = goldenFilePath(name);

        if (Boolean.getBoolean(UPDATE_PROPERTY)) {
            Files.createDirectories(golden.getParent());
            Files.writeString(golden, actual, StandardCharsets.UTF_8, StandardOpenOption.CREATE, StandardOpenOption.TRUNCATE_EXISTING);
            fail(
                    "snapshot '"
                            + name
                            + "' regenerated at "
                            + golden.toAbsolutePath()
                            + " — review the git diff, then re-run WITHOUT -Dsnapshot.update to confirm it passes");
        }

        if (!Files.exists(golden)) {
            fail(
                    "no golden master at "
                            + golden.toAbsolutePath()
                            + " — run once with -Dsnapshot.update=true to create it, then review and commit");
        }

        String expected = Files.readString(golden, StandardCharsets.UTF_8);
        assertThat(actual)
                .as(
                        "output for snapshot '%s' diverged from the checked-in golden master at %s."
                                + " If this divergence is intended, re-run with -Dsnapshot.update=true,"
                                + " review the diff, and commit the updated file.",
                        name,
                        golden)
                .isEqualTo(expected);
    }

    /**
     * Resolves the golden file against the module's source tree, not the test
     * classpath. Surefire's working directory is the module base directory by
     * default, and writing here — rather than to {@code target/test-classes} —
     * is what lets an update actually land somewhere {@code git diff} can see.
     */
    private static Path goldenFilePath(String name) {
        return Path.of("src", "test", "resources", "snapshots", name + ".json");
    }

    @Test
    @DisplayName("core: calls, implements, dispatch, inherited routes, scheduled jobs")
    void coreSnapshot() throws IOException {
        SnapshotFixtures.core(workspace);
        compareToGoldenMaster("core", workspace);
    }

    @Test
    @DisplayName("spring-data: queries/maps_to, and non-zero diagnostics")
    void springDataSnapshot() throws IOException {
        SnapshotFixtures.springData(workspace);
        compareToGoldenMaster("spring-data", workspace);
    }
}
