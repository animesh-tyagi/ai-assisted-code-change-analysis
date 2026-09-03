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
    @DisplayName("inherited route mappings")
    class InheritedRoutes {

        @Test
        void aControllerInheritsTheMappingFromAGeneratedApiInterface() throws IOException {
            // This is petclinic's real shape: the hand-written controller carries
            // only the class-level @RequestMapping and implements an OpenAPI-
            // generated interface where every method-level mapping actually lives.
            // The generated interface is on the solver path but NOT extracted, so
            // this also confirms the mechanism the whole rule depends on —
            // annotations are readable off an AST reached through the type solver,
            // even though that parse carries no symbol resolver of its own.
            writeSource(
                    "target/generated-sources/openapi/src/main/java/com/acme/api/OwnersApi.java",
                    """
                    package com.acme.api;
                    public interface OwnersApi {
                        @RequestMapping(method = RequestMethod.GET, value = "/owners/{id}")
                        String getOwner(Integer id);
                        @RequestMapping(method = RequestMethod.POST, value = "/owners")
                        String addOwner(String body);
                    }
                    """);
            writeSource(
                    "src/main/java/com/acme/OwnerController.java",
                    """
                    package com.acme;
                    import com.acme.api.OwnersApi;
                    @RestController
                    @RequestMapping("/api")
                    class OwnerController implements OwnersApi {
                        @Override
                        public String getOwner(Integer id) { return "x"; }
                        @Override
                        public String addOwner(String body) { return "y"; }
                    }
                    """);

            ExtractionResult result = extract();

            // The class-level prefix belongs to the controller, the method-level
            // path to the interface.
            assertThat(result.surfaces())
                    .filteredOn(s -> s.kind() == SurfaceKind.HTTP_ROUTE)
                    .extracting(Surface::key)
                    .containsExactlyInAnyOrder(
                            "route:GET /api/owners/{id}", "route:POST /api/owners");

            // The handles edge attaches to the IN-REPO controller method. No node
            // is created for the generated interface.
            var handles = edge(result, "route:GET /api/owners/{id}", EdgeType.HANDLES);
            assertThat(handles).isPresent();
            assertThat(handles.get().to())
                    .isEqualTo("fn:com.acme.OwnerController#getOwner(java.lang.Integer)");
            assertThat(handles.get().inferred()).isTrue();
            assertThat(handles.get().confidence()).isEqualTo(Confidence.EXACT);

            assertThat(result.functions())
                    .extracting(f -> f.fqcn())
                    .doesNotContain("com.acme.api.OwnersApi");
        }

        @Test
        void anOwnMappingWinsOverAnInheritedOne() throws IOException {
            writeSource(
                    "src/main/java/com/acme/Base.java",
                    """
                    package com.acme;
                    public interface Base {
                        @GetMapping("/from-interface")
                        String go();
                    }
                    """);
            writeSource(
                    "src/main/java/com/acme/Impl.java",
                    """
                    package com.acme;
                    @RequestMapping("/api")
                    class Impl implements Base {
                        @Override
                        @GetMapping("/own")
                        public String go() { return "x"; }
                    }
                    """);

            assertThat(extract().surfaces())
                    .filteredOn(s -> s.kind() == SurfaceKind.HTTP_ROUTE)
                    .extracting(Surface::key)
                    .containsExactly("route:GET /api/own");
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
        void anArrayValuedTopicsMemberTakesTheFirstRatherThanConcatenatingAll() throws IOException {
            // A pre-merge review triage: members()/literalOf() render an
            // array-valued member as its raw source text ({"a", "b"}), and this
            // rule used to regex-strip {}" straight off that text — for two or
            // more topics that produced one comma-joined, meaningless key
            // ("orders.created, orders.updated") instead of picking one, unlike
            // @RequestMapping arrays which already took-first via firstValue().
            writeSource(
                    "src/main/java/com/acme/L.java",
                    """
                    package com.acme;
                    class L {
                        @KafkaListener(topics = {"orders.created", "orders.updated"})
                        void onOrder(String payload) {}
                    }
                    """);

            ExtractionResult result = extract();

            assertThat(surface(result, "listener:kafka:orders.created"))
                    .isPresent()
                    .get()
                    .satisfies(
                            s -> {
                                assertThat(s.kind()).isEqualTo(SurfaceKind.MESSAGE_LISTENER);
                                assertThat(s.attrs()).containsEntry("topic", "orders.created");
                            });
            assertThat(result.surfaces())
                    .as("only one listener surface — v1 takes the first topic, does not fan out")
                    .hasSize(1);
        }

        @Test
        void aMethodWithNoEntryPointAnnotationProducesNoSurface() throws IOException {
            writeSource(
                    "src/main/java/com/acme/Plain.java",
                    "package com.acme; class Plain { void ordinary() {} }");

            assertThat(extract().surfaces()).isEmpty();
        }

        @Test
        void anOverrideInheritsAListenerAnnotationLeftOnlyOnTheInterface() throws IOException {
            // Mirrors InheritedRoutes' generated-API-interface shape, but for
            // @KafkaListener: the concrete method carries no annotation of its
            // own, so before the interface-suppression check was generalized to
            // scheduledJob/messageListener, this produced no surface at all.
            writeSource(
                    "src/main/java/com/acme/OrderListener.java",
                    """
                    package com.acme;
                    public interface OrderListener {
                        @KafkaListener(topics = "orders.created")
                        void onOrder(String payload);
                    }
                    """);
            writeSource(
                    "src/main/java/com/acme/OrderListenerImpl.java",
                    """
                    package com.acme;
                    class OrderListenerImpl implements OrderListener {
                        @Override
                        public void onOrder(String payload) {}
                    }
                    """);

            ExtractionResult result = extract();

            assertThat(surface(result, "listener:kafka:orders.created")).isPresent();
            assertThat(edge(result, "listener:kafka:orders.created", EdgeType.TRIGGERS))
                    .isPresent()
                    .get()
                    .satisfies(
                            e ->
                                    assertThat(e.to())
                                            .isEqualTo("fn:com.acme.OrderListenerImpl#onOrder(java.lang.String)"));
        }

        @Test
        void twoScheduledMethodsOnOneSourceLineGetDistinctSurfaces() throws IOException {
            // Declarations.keyOfIndexed looks a method's own key up by source
            // position; the index used to key by line alone, so two callables
            // starting on the same line (legal Java, and something a formatter
            // or generator can produce) collided in keysByPosition, and the
            // second one's entry silently won for both. Column was added to the
            // position key specifically to prevent this.
            writeSource(
                    "src/main/java/com/acme/Two.java",
                    """
                    package com.acme;
                    class Two {
                        @Scheduled(fixedRate = 1000) void a() {} @Scheduled(fixedRate = 2000) void b() {}
                    }
                    """);

            ExtractionResult result = extract();

            assertThat(edge(result, "job:com.acme.Two#a()", EdgeType.TRIGGERS))
                    .isPresent()
                    .get()
                    .satisfies(e -> assertThat(e.to()).isEqualTo("fn:com.acme.Two#a()"));
            assertThat(edge(result, "job:com.acme.Two#b()", EdgeType.TRIGGERS))
                    .isPresent()
                    .get()
                    .satisfies(e -> assertThat(e.to()).isEqualTo("fn:com.acme.Two#b()"));
        }

        @Test
        void anAnnotationDeclaredOnlyOnAnInterfaceMethodProducesNoSurface() throws IOException {
            // An interface method can never itself be scheduled or invoked as a
            // listener — there is no bean to run it. Before the fix, the missing
            // type.isInterface() guard let this produce a job: surface for a
            // method that can never actually fire.
            writeSource(
                    "src/main/java/com/acme/Unimplemented.java",
                    """
                    package com.acme;
                    public interface Unimplemented {
                        @Scheduled(fixedRate = 5000)
                        void snapshot();
                    }
                    """);

            assertThat(extract().surfaces()).isEmpty();
        }
    }
}
