package com.impact.parser.extract;

import static org.assertj.core.api.Assertions.assertThat;

import com.impact.parser.graph.Confidence;
import com.impact.parser.graph.EdgeType;
import com.impact.parser.graph.GraphEdge;
import com.impact.parser.graph.UnresolvedReason;
import com.impact.parser.resolve.SourceAndJdkTypeSolverFactory;
import com.impact.parser.workspace.SourceRootDiscovery;
import com.impact.parser.workspace.WorkspaceLayout;
import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;
import java.util.Optional;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Nested;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

/**
 * Phase 4: the structural edges of section 6.3 and the unresolved sink of
 * section 6.5.
 */
class EdgeExtractorTest {

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

    private static Optional<GraphEdge> edge(ExtractionResult result, String from, String to, EdgeType type) {
        return result.edges().stream()
                .filter(e -> e.from().equals(from) && e.to().equals(to) && e.type() == type)
                .findFirst();
    }

    private static List<GraphEdge> ofType(ExtractionResult result, EdgeType type) {
        return result.edges().stream().filter(e -> e.type() == type).toList();
    }

    // -----------------------------------------------------------------------
    // calls
    // -----------------------------------------------------------------------

    @Nested
    @DisplayName("calls edges")
    class Calls {

        @Test
        void pointFromTheCallerToTheCallee() throws IOException {
            // Direction is the product: reverse traversal matches `to` and collects
            // `from`, so getting this backwards would invert every answer.
            writeSource(
                    "src/main/java/com/acme/Svc.java",
                    """
                    package com.acme;
                    class Svc {
                        String findById(Long id) { return "x"; }
                    }
                    """);
            writeSource(
                    "src/main/java/com/acme/Caller.java",
                    """
                    package com.acme;
                    class Caller {
                        void go(Svc svc) { svc.findById(1L); }
                    }
                    """);

            var found =
                    edge(
                            extract(),
                            "fn:com.acme.Caller#go(com.acme.Svc)",
                            "fn:com.acme.Svc#findById(java.lang.Long)",
                            EdgeType.CALLS);

            assertThat(found).isPresent();
            assertThat(found.get().confidence()).isEqualTo(Confidence.EXACT);
            assertThat(found.get().inferred()).isFalse();
        }

        @Test
        void repeatedCallsCollapseIntoOneEdgeWithSeveralCallSites() throws IOException {
            // Section 7 keeps one edge per (from,to,type) with a callSites array.
            // Duplicates would break the unique index and, worse, inflate
            // directCallerTotal — a number handed to the LLM as fact.
            writeSource(
                    "src/main/java/com/acme/Svc.java",
                    "package com.acme; class Svc { void ping() {} }");
            writeSource(
                    "src/main/java/com/acme/Caller.java",
                    """
                    package com.acme;
                    class Caller {
                        void go(Svc svc) {
                            svc.ping();
                            svc.ping();
                            svc.ping();
                        }
                    }
                    """);

            var found =
                    edge(
                            extract(),
                            "fn:com.acme.Caller#go(com.acme.Svc)",
                            "fn:com.acme.Svc#ping()",
                            EdgeType.CALLS);

            assertThat(found).isPresent();
            assertThat(found.get().callSites()).hasSize(3);
            assertThat(found.get().callSites()).isSorted();
        }

        @Test
        void constructorCallsAreEdgesToInit() throws IOException {
            writeSource(
                    "src/main/java/com/acme/Thing.java",
                    "package com.acme; class Thing { Thing(String name) {} }");
            writeSource(
                    "src/main/java/com/acme/Factory.java",
                    """
                    package com.acme;
                    class Factory {
                        Thing make() { return new Thing("x"); }
                    }
                    """);

            assertThat(
                            edge(
                                    extract(),
                                    "fn:com.acme.Factory#make()",
                                    "fn:com.acme.Thing#<init>(java.lang.String)",
                                    EdgeType.CALLS))
                    .isPresent();
        }

        @Test
        void methodReferencesCountAsCalls() throws IOException {
            // `this::handle` makes handle reachable just as `handle()` does, so a
            // change to it affects this caller.
            writeSource(
                    "src/main/java/com/acme/Svc.java",
                    """
                    package com.acme;
                    import java.util.List;
                    class Svc {
                        void handle(String value) {}
                        void run(List<String> items) { items.forEach(this::handle); }
                    }
                    """);

            assertThat(
                            edge(
                                    extract(),
                                    "fn:com.acme.Svc#run(java.util.List)",
                                    "fn:com.acme.Svc#handle(java.lang.String)",
                                    EdgeType.CALLS))
                    .isPresent();
        }

        @Test
        void constructorReferencesBecomeUnresolvedRatherThanVanishingWithoutTrace() throws IOException {
            // A pre-merge review flagged resolveMethodReference for handling only
            // the ResolvedMethodDeclaration case, hypothesising that Type::new
            // (which is a constructor reference) would fall through silently —
            // no edge, no unresolved marker, no counter, nothing. Verified by
            // probing JavaParser 3.27.0 directly before trusting that claim:
            // MethodReferenceExpr#resolve() throws UnsupportedOperationException
            // ("Constructor calls not yet resolvable") for a constructor
            // reference — it never returns a ResolvedConstructorDeclaration to
            // fall through on. So the call site was never silently dropped; the
            // existing catch already turned it into an `unresolved:` edge. The
            // severity in the original report was overstated — corrected here
            // rather than left standing.
            //
            // The fix keeps its value regardless: resolveMethodReference now
            // branches on ResolvedConstructorDeclaration too, so if a future
            // JavaParser version does resolve Type::new, this becomes a proper
            // `calls` edge to the real constructor instead of staying
            // permanently unresolved. Today, this test pins the CURRENT
            // behaviour — unresolved, not silently dropped — so a JavaParser
            // upgrade that starts resolving it is a visible test change, not a
            // silent one.
            writeSource(
                    "src/main/java/com/acme/Widget.java",
                    """
                    package com.acme;
                    class Widget {
                        Widget(String name) {}
                    }
                    """);
            writeSource(
                    "src/main/java/com/acme/Factory.java",
                    """
                    package com.acme;
                    import java.util.function.Function;
                    class Factory {
                        Function<String, Widget> supplier() { return Widget::new; }
                    }
                    """);

            ExtractionResult result = extract();

            assertThat(edge(result, "fn:com.acme.Factory#supplier()", "fn:com.acme.Widget#<init>(java.lang.String)", EdgeType.CALLS))
                    .as("not yet resolvable in this JavaParser version — see the comment above")
                    .isEmpty();
            assertThat(result.edges())
                    .as("but the call site is not silently lost — it becomes unresolved:, per section 6.5")
                    .anyMatch(e -> e.from().equals("fn:com.acme.Factory#supplier()") && e.type() == EdgeType.UNRESOLVED);
        }

        @Test
        void callsToTheJdkAreCountedButNotGraphed() throws IOException {
            // D2: the impact surface is entirely intra-repo. Nobody can act on a
            // change to java.util.HashMap, and reverse traversal would never walk
            // through it — but the omission is counted, never silent.
            writeSource(
                    "src/main/java/com/acme/Svc.java",
                    """
                    package com.acme;
                    import java.util.HashMap;
                    class Svc {
                        int go() {
                            HashMap<String, String> map = new HashMap<>();
                            return map.size();
                        }
                    }
                    """);

            ExtractionResult result = extract();

            assertThat(result.edges()).isEmpty();
            assertThat(result.externalCalls()).isGreaterThanOrEqualTo(2);
            // Not confused with a resolution failure: unresolvedRate stays a
            // measure of blindness, not of scope.
            assertThat(result.unresolvedEdges()).isZero();
        }

        @Test
        void callsAreAttributedToTheirImmediateEnclosingCallable() throws IOException {
            writeSource(
                    "src/main/java/com/acme/Svc.java",
                    """
                    package com.acme;
                    class Svc {
                        void target() {}
                        void outer() {
                            class Local {
                                void inner() { }
                            }
                            target();
                        }
                    }
                    """);

            ExtractionResult result = extract();

            assertThat(
                            edge(
                                    result,
                                    "fn:com.acme.Svc#outer()",
                                    "fn:com.acme.Svc#target()",
                                    EdgeType.CALLS))
                    .isPresent();
        }
    }

    // -----------------------------------------------------------------------
    // implements / overrides
    // -----------------------------------------------------------------------

    @Nested
    @DisplayName("inheritance edges")
    class Inheritance {

        @Test
        void implementsEdgesAreStructuralAndNotGatedOnAnnotations() throws IOException {
            // Section 6.4, as rewritten: discovery is annotation-independent. The
            // real FailureStrategy in observability-final has four hand-wired impls
            // with no @Service anywhere.
            writeSource(
                    "src/main/java/com/acme/Strategy.java",
                    """
                    package com.acme;
                    interface Strategy {
                        void execute(String input);
                    }
                    """);
            writeSource(
                    "src/main/java/com/acme/PlainImpl.java",
                    """
                    package com.acme;
                    public class PlainImpl implements Strategy {
                        public void execute(String input) {}
                    }
                    """);

            var found =
                    edge(
                            extract(),
                            "fn:com.acme.PlainImpl#execute(java.lang.String)",
                            "fn:com.acme.Strategy#execute(java.lang.String)",
                            EdgeType.IMPLEMENTS);

            assertThat(found).isPresent();
            // A structural type fact, so exact and not inferred.
            assertThat(found.get().confidence()).isEqualTo(Confidence.EXACT);
            assertThat(found.get().inferred()).isFalse();
        }

        @Test
        void everyImplementationGetsAnImplementsEdge() throws IOException {
            writeSource(
                    "src/main/java/com/acme/Strategy.java",
                    "package com.acme; interface Strategy { void execute(); }");
            writeSource(
                    "src/main/java/com/acme/A.java",
                    "package com.acme; public class A implements Strategy { public void execute() {} }");
            writeSource(
                    "src/main/java/com/acme/B.java",
                    "package com.acme; public class B implements Strategy { public void execute() {} }");

            assertThat(ofType(extract(), EdgeType.IMPLEMENTS))
                    .extracting(GraphEdge::from)
                    .containsExactlyInAnyOrder("fn:com.acme.A#execute()", "fn:com.acme.B#execute()");
        }

        @Test
        void subclassMethodsOverrideTheirSuperclass() throws IOException {
            writeSource(
                    "src/main/java/com/acme/Base.java",
                    "package com.acme; public class Base { public void run() {} }");
            writeSource(
                    "src/main/java/com/acme/Derived.java",
                    "package com.acme; public class Derived extends Base { public void run() {} }");

            assertThat(
                            edge(
                                    extract(),
                                    "fn:com.acme.Derived#run()",
                                    "fn:com.acme.Base#run()",
                                    EdgeType.OVERRIDES))
                    .isPresent();
        }

        @Test
        void overloadsDoNotCountAsOverrides() throws IOException {
            writeSource(
                    "src/main/java/com/acme/Base.java",
                    "package com.acme; public class Base { public void run(String s) {} }");
            writeSource(
                    "src/main/java/com/acme/Derived.java",
                    "package com.acme; public class Derived extends Base { public void run(int i) {} }");

            assertThat(ofType(extract(), EdgeType.OVERRIDES)).isEmpty();
        }

        @Test
        void frameworkSupertypesProduceNoEdge() throws IOException {
            // Documented consequence: implementing an unresolvable framework
            // interface yields no edge, so such methods look callerless until an
            // entry-point surface covers them (section 6.4).
            writeSource(
                    "src/main/java/com/acme/Interceptor.java",
                    """
                    package com.acme;
                    import org.springframework.web.servlet.HandlerInterceptor;
                    public class Interceptor implements HandlerInterceptor {
                        public boolean preHandle(Object a, Object b, Object c) { return true; }
                    }
                    """);

            ExtractionResult result = extract();

            assertThat(ofType(result, EdgeType.IMPLEMENTS)).isEmpty();
            // The node itself still exists — that is the part that must not be lost.
            assertThat(result.functions()).extracting(f -> f.methodName()).contains("preHandle");
        }
    }

    // -----------------------------------------------------------------------
    // unresolved (section 6.5) and overloads (section 6.6)
    // -----------------------------------------------------------------------

    @Nested
    @DisplayName("unresolved calls")
    class Unresolved {

        @Test
        void unbindableCallsBecomeUnresolvedEdgesRatherThanDisappearing() throws IOException {
            writeSource(
                    "src/main/java/com/acme/Svc.java",
                    """
                    package com.acme;
                    import com.thirdparty.Widget;
                    class Svc {
                        void go(Widget widget) { widget.doSomething(); }
                    }
                    """);

            ExtractionResult result = extract();
            List<GraphEdge> unresolved = ofType(result, EdgeType.UNRESOLVED);

            assertThat(unresolved).hasSize(1);
            assertThat(unresolved.getFirst().from()).isEqualTo("fn:com.acme.Svc#go(com.thirdparty.Widget)");
            assertThat(unresolved.getFirst().to()).startsWith("unresolved:");
            // The best available target is carried, so a spike in unresolvedRate
            // stays traceable to a named thing.
            assertThat(unresolved.getFirst().to()).contains("doSomething");
            assertThat(unresolved.getFirst().reason()).isEqualTo(UnresolvedReason.EXTERNAL_TYPE);
            assertThat(result.unresolvedRate()).isEqualTo(1.0);
        }

        @Test
        void unresolvedRateIsEdgesWeFailedToBindNotEdgesWeExcluded() throws IOException {
            writeSource(
                    "src/main/java/com/acme/Svc.java",
                    """
                    package com.acme;
                    import java.util.ArrayList;
                    class Svc {
                        void inRepo() {}
                        void go() {
                            inRepo();
                            new ArrayList<String>().size();
                        }
                    }
                    """);

            ExtractionResult result = extract();

            assertThat(result.unresolvedRate()).isZero();
            assertThat(result.externalCalls()).isPositive();
        }
    }
}
