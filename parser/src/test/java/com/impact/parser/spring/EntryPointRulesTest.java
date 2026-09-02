package com.impact.parser.spring;

import static org.assertj.core.api.Assertions.assertThat;

import com.impact.parser.extract.ExtractionResult;
import com.impact.parser.extract.GraphExtractor;
import com.impact.parser.graph.Confidence;
import com.impact.parser.graph.EdgeType;
import com.impact.parser.graph.GraphEdge;
import com.impact.parser.graph.Surface;
import com.impact.parser.graph.SurfaceKind;
import com.impact.parser.resolve.SourceAndJdkTypeSolverFactory;
import com.impact.parser.workspace.SourceRootDiscovery;
import com.impact.parser.workspace.WorkspaceLayout;
import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.Optional;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Nested;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

/**
 * Entry-point rules (ARCHITECTURE.md §6.4).
 *
 * <p>These matter more than they look. A controller method has no in-repo caller —
 * Spring invokes it — so without a route surface it appears dead and a change to
 * it appears to affect nobody, which is the precise failure this product exists to
 * prevent.
 */
class EntryPointRulesTest {

    @TempDir Path tempDir;

    private void writeSource(String relativePath, String source) throws IOException {
        Path file = tempDir.resolve(relativePath);
        Files.createDirectories(file.getParent());
        Files.writeString(file, source);
    }

    private ExtractionResult extract() {
        WorkspaceLayout layout = SourceRootDiscovery.discover(tempDir, false);
        var solver = new SourceAndJdkTypeSolverFactory().create(layout);
        return new GraphExtractor(solver).extract(layout, SourceRootDiscovery.javaFiles(layout));
    }

    private static Optional<Surface> surface(ExtractionResult result, String key) {
        return result.surfaces().stream().filter(s -> s.key().equals(key)).findFirst();
    }

    private static Optional<GraphEdge> edge(ExtractionResult result, String from, EdgeType type) {
        return result.edges().stream()
                .filter(e -> e.from().equals(from) && e.type() == type)
                .findFirst();
    }

    @Nested
    @DisplayName("HTTP routes")
    class Routes {

        @Test
        void concatenatesClassAndMethodPathsAndPointsTheRouteAtTheHandler() throws IOException {
            writeSource(
                    "src/main/java/com/acme/OwnerController.java",
                    """
                    package com.acme;
                    @RestController
                    @RequestMapping("/api/owners")
                    class OwnerController {
                        @GetMapping("/{id}")
                        String get(int id) { return "x"; }
                    }
                    """);

            ExtractionResult result = extract();

            assertThat(surface(result, "route:GET /api/owners/{id}"))
                    .isPresent()
                    .get()
                    .satisfies(s -> assertThat(s.kind()).isEqualTo(SurfaceKind.HTTP_ROUTE));

            // Direction: the route depends on the handler, so reverse traversal
            // from a changed handler finds the route by matching `to`.
            var handles = edge(result, "route:GET /api/owners/{id}", EdgeType.HANDLES);
            assertThat(handles).isPresent();
            assertThat(handles.get().to()).isEqualTo("fn:com.acme.OwnerController#get(int)");
            assertThat(handles.get().inferred()).isTrue();
            assertThat(handles.get().confidence()).isEqualTo(Confidence.EXACT);
        }

        @Test
        void normalisesSlashesSoOneRouteIsNotTwoNodes() throws IOException {
            writeSource(
                    "src/main/java/com/acme/A.java",
                    """
                    package com.acme;
                    @RequestMapping("/api/")
                    class A {
                        @GetMapping("/list")
                        String a() { return "x"; }
                    }
                    """);
            writeSource(
                    "src/main/java/com/acme/B.java",
                    """
                    package com.acme;
                    @RequestMapping("/api")
                    class B {
                        @GetMapping("list")
                        String b() { return "x"; }
                    }
                    """);

            // Same route path from two different spellings — the key must match, or
            // one endpoint would appear as two surfaces.
            assertThat(extract().surfaces())
                    .filteredOn(s -> s.kind() == SurfaceKind.HTTP_ROUTE)
                    .extracting(Surface::key)
                    .containsOnly("route:GET /api/list");
        }

        @Test
        void handlesEveryVerbAndABareRequestMapping() throws IOException {
            writeSource(
                    "src/main/java/com/acme/C.java",
                    """
                    package com.acme;
                    @RequestMapping("/r")
                    class C {
                        @PostMapping("/a") void a() {}
                        @PutMapping("/b") void b() {}
                        @DeleteMapping("/c") void c() {}
                        @PatchMapping("/d") void d() {}
                        @RequestMapping(value = "/e", method = RequestMethod.GET) void e() {}
                        @RequestMapping("/f") void f() {}
                    }
                    """);

            assertThat(extract().surfaces())
                    .filteredOn(s -> s.kind() == SurfaceKind.HTTP_ROUTE)
                    .extracting(Surface::key)
                    .containsExactlyInAnyOrder(
                            "route:POST /r/a",
                            "route:PUT /r/b",
                            "route:DELETE /r/c",
                            "route:PATCH /r/d",
                            "route:GET /r/e",
                            // No `method =` member means Spring maps every verb.
                            // Recording ANY is honest; inventing GET would not be.
                            "route:ANY /r/f");
        }

        @Test
        void flagsUnresolvedPropertyPlaceholdersRatherThanGuessing() throws IOException {
            writeSource(
                    "src/main/java/com/acme/D.java",
                    """
                    package com.acme;
                    @RequestMapping("${api.base}")
                    class D {
                        @GetMapping("/x") void x() {}
                    }
                    """);

            ExtractionResult result = extract();
            var handles =
                    result.edges().stream().filter(e -> e.type() == EdgeType.HANDLES).findFirst();

            assertThat(handles).isPresent();
            assertThat(handles.get().from()).contains("${api.base}");
            assertThat(handles.get().confidence()).isEqualTo(Confidence.AMBIGUOUS);
        }
    }

    @Nested
    @DisplayName("scheduled jobs and listeners")
    class OtherEntryPoints {

        @Test
        void scheduledMethodsBecomeJobSurfaces() throws IOException {
            writeSource(
                    "src/main/java/com/acme/Agg.java",
                    """
                    package com.acme;
                    class Agg {
                        @Scheduled(fixedRate = 5000)
                        void snapshot() {}
                    }
                    """);

            ExtractionResult result = extract();

            assertThat(surface(result, "job:com.acme.Agg#snapshot()"))
                    .isPresent()
                    .get()
                    .satisfies(
                            s -> {
                                assertThat(s.kind()).isEqualTo(SurfaceKind.SCHEDULED_JOB);
                                assertThat(s.attrs()).containsEntry("fixedRate", "5000");
                            });
            assertThat(edge(result, "job:com.acme.Agg#snapshot()", EdgeType.TRIGGERS))
                    .isPresent()
                    .get()
                    .satisfies(e -> assertThat(e.to()).isEqualTo("fn:com.acme.Agg#snapshot()"));
        }

        @Test
        void listenersAreKeyedByBrokerAndTopic() throws IOException {
            writeSource(
                    "src/main/java/com/acme/L.java",
                    """
                    package com.acme;
                    class L {
                        @KafkaListener(topics = "orders.created")
                        void onOrder(String payload) {}
                    }
                    """);

            ExtractionResult result = extract();

            assertThat(surface(result, "listener:kafka:orders.created"))
                    .isPresent()
                    .get()
                    .satisfies(s -> assertThat(s.kind()).isEqualTo(SurfaceKind.MESSAGE_LISTENER));
            assertThat(edge(result, "listener:kafka:orders.created", EdgeType.TRIGGERS)).isPresent();
        }

        @Test
        void aMethodWithNoEntryPointAnnotationProducesNoSurface() throws IOException {
            writeSource(
                    "src/main/java/com/acme/Plain.java",
                    "package com.acme; class Plain { void ordinary() {} }");

            assertThat(extract().surfaces()).isEmpty();
        }
    }
}
