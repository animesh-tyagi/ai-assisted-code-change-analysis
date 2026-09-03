package com.impact.parser.graph;

import static org.assertj.core.api.Assertions.assertThat;

import com.github.javaparser.JavaParser;
import com.github.javaparser.ParserConfiguration;
import com.github.javaparser.ast.CompilationUnit;
import com.github.javaparser.ast.body.ConstructorDeclaration;
import com.github.javaparser.ast.body.MethodDeclaration;
import com.github.javaparser.ast.expr.MethodCallExpr;
import com.github.javaparser.resolution.declarations.ResolvedMethodDeclaration;
import com.github.javaparser.symbolsolver.JavaSymbolSolver;
import com.github.javaparser.symbolsolver.resolution.typesolvers.CombinedTypeSolver;
import com.github.javaparser.symbolsolver.resolution.typesolvers.ReflectionTypeSolver;
import java.util.List;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Nested;
import org.junit.jupiter.api.Test;

/**
 * The node key is the project's most load-bearing identifier (CLAUDE.md rule 4),
 * and a bug here is silent: a changed method would look like a delete plus a
 * create, losing every edge and all history attached to it. CLAUDE.md therefore
 * requires this under test before anything is built on it.
 */
class NodeKeysTest {

    // -----------------------------------------------------------------------
    // Helpers
    // -----------------------------------------------------------------------

    private static CompilationUnit parse(String source) {
        CombinedTypeSolver typeSolver = new CombinedTypeSolver(new ReflectionTypeSolver());
        ParserConfiguration config =
                new ParserConfiguration().setSymbolResolver(new JavaSymbolSolver(typeSolver));
        return new JavaParser(config).parse(source).getResult().orElseThrow();
    }

    private static String keyOf(String source, String methodName) {
        ResolvedMethodDeclaration method =
                parse(source).findAll(MethodDeclaration.class).stream()
                        .filter(m -> m.getNameAsString().equals(methodName))
                        .findFirst()
                        .orElseThrow(() -> new AssertionError("no method named " + methodName))
                        .resolve();
        return NodeKeys.forMethod(method);
    }

    // -----------------------------------------------------------------------
    // Cross-check against the TypeScript consumer
    // -----------------------------------------------------------------------

    @Nested
    @DisplayName("agrees byte-for-byte with shared/src/nodeKey.ts")
    class CrossChecksWithTypeScript {

        // These literals are copied verbatim from shared/src/nodeKey.test.ts. Java
        // produces keys and TypeScript parses them; if the two ever disagree, node
        // identity silently splits in half across the system. Keep both in sync.

        @Test
        void documentedFormFromSection6_1() {
            assertThat(NodeKeys.format("com.acme.user.UserService", "findById", List.of("java.lang.Long")))
                    .isEqualTo("fn:com.acme.user.UserService#findById(java.lang.Long)");
        }

        @Test
        void zeroArgMethodGetsEmptyParens() {
            assertThat(NodeKeys.format("com.acme.Job", "run", List.of()))
                    .isEqualTo("fn:com.acme.Job#run()");
        }

        @Test
        void parametersJoinWithNoWhitespace() {
            assertThat(
                            NodeKeys.format(
                                    "com.acme.Svc",
                                    "update",
                                    List.of("java.lang.Long", "java.lang.String", "int")))
                    .isEqualTo("fn:com.acme.Svc#update(java.lang.Long,java.lang.String,int)");
        }

        @Test
        void arrayParameters() {
            assertThat(NodeKeys.format("com.acme.Fmt", "join", List.of("java.lang.String[]", "int")))
                    .isEqualTo("fn:com.acme.Fmt#join(java.lang.String[],int)");
        }
    }

    // -----------------------------------------------------------------------
    // Derivation from real resolved source
    // -----------------------------------------------------------------------

    @Nested
    @DisplayName("derives keys from resolved declarations")
    class Derivation {

        @Test
        void fullyQualifiesTheClassAndParameterTypes() {
            String key =
                    keyOf(
                            """
                            package com.acme.user;
                            class UserService {
                                Object findById(Long id) { return null; }
                            }
                            """,
                            "findById");

            assertThat(key).isEqualTo("fn:com.acme.user.UserService#findById(java.lang.Long)");
        }

        @Test
        void zeroArgMethod() {
            String key =
                    keyOf(
                            """
                            package com.acme.billing;
                            class NightlyJob {
                                void run() {}
                            }
                            """,
                            "run");

            assertThat(key).isEqualTo("fn:com.acme.billing.NightlyJob#run()");
        }

        @Test
        void primitivesKeepTheirOwnNames() {
            String key =
                    keyOf(
                            """
                            package com.acme;
                            class Calc {
                                void go(int a, long b, boolean c, double d, char e) {}
                            }
                            """,
                            "go");

            assertThat(key).isEqualTo("fn:com.acme.Calc#go(int,long,boolean,double,char)");
        }

        @Test
        void arraysKeepTheirDimension() {
            String key =
                    keyOf(
                            """
                            package com.acme;
                            class Fmt {
                                void go(String[] names, int[][] grid) {}
                            }
                            """,
                            "go");

            assertThat(key).isEqualTo("fn:com.acme.Fmt#go(java.lang.String[],int[][])");
        }

        @Test
        void varargsBecomeArrays() {
            // String... is String[] at the JVM level, so rewriting the declaration
            // as an explicit array must not change the key.
            String varargsKey =
                    keyOf(
                            """
                            package com.acme;
                            class Fmt {
                                void join(String separator, String... parts) {}
                            }
                            """,
                            "join");

            String arrayKey =
                    keyOf(
                            """
                            package com.acme;
                            class Fmt {
                                void join(String separator, String[] parts) {}
                            }
                            """,
                            "join");

            assertThat(varargsKey)
                    .isEqualTo("fn:com.acme.Fmt#join(java.lang.String,java.lang.String[])")
                    .isEqualTo(arrayKey);
        }
    }

    // -----------------------------------------------------------------------
    // Erasure — the part most likely to be silently wrong
    // -----------------------------------------------------------------------

    @Nested
    @DisplayName("erases types the way the JVM does")
    class Erasure {

        @Test
        void genericsDropToTheirRawType() {
            String key =
                    keyOf(
                            """
                            package com.acme;
                            import java.util.List;
                            class Repo {
                                void save(List<String> items) {}
                            }
                            """,
                            "save");

            assertThat(key).isEqualTo("fn:com.acme.Repo#save(java.util.List)");
        }

        @Test
        void nestedGenericsDoNotLeakTheirCommasIntoTheKey() {
            // This is the case that makes string-parsing getQualifiedSignature()
            // unsafe: the rendered signature contains a comma *inside* one
            // parameter. The key must still show exactly one parameter.
            String key =
                    keyOf(
                            """
                            package com.acme;
                            import java.util.List;
                            import java.util.Map;
                            class Repo {
                                void save(Map<String, List<Integer>> byName) {}
                            }
                            """,
                            "save");

            assertThat(key).isEqualTo("fn:com.acme.Repo#save(java.util.Map)");
            assertThat(key.substring(key.indexOf('(') + 1, key.length() - 1)).doesNotContain(",");
        }

        @Test
        void unboundedTypeVariablesEraseToObject() {
            String key =
                    keyOf(
                            """
                            package com.acme;
                            class Box {
                                <T> void put(T value) {}
                            }
                            """,
                            "put");

            assertThat(key).isEqualTo("fn:com.acme.Box#put(java.lang.Object)");
        }

        @Test
        void boundedTypeVariablesEraseToTheirFirstBound() {
            String key =
                    keyOf(
                            """
                            package com.acme;
                            class Box {
                                <T extends Number> void put(T value) {}
                            }
                            """,
                            "put");

            assertThat(key).isEqualTo("fn:com.acme.Box#put(java.lang.Number)");
        }

        @Test
        void wildcardsEraseToTheContainerRawType() {
            String key =
                    keyOf(
                            """
                            package com.acme;
                            import java.util.List;
                            class Box {
                                void putAll(List<?> values) {}
                            }
                            """,
                            "putAll");

            assertThat(key).isEqualTo("fn:com.acme.Box#putAll(java.util.List)");
        }
    }

    // -----------------------------------------------------------------------
    // Identity properties the graph depends on
    // -----------------------------------------------------------------------

    @Nested
    @DisplayName("identity properties")
    class Identity {

        @Test
        void overloadsGetDistinctKeys() {
            String source =
                    """
                    package com.acme;
                    class Svc {
                        void handle(String value) {}
                        void handle(int value) {}
                        void handle(String value, int count) {}
                    }
                    """;

            List<String> keys =
                    parse(source).findAll(MethodDeclaration.class).stream()
                            .map(m -> NodeKeys.forMethod(m.resolve()))
                            .toList();

            assertThat(keys)
                    .containsExactly(
                            "fn:com.acme.Svc#handle(java.lang.String)",
                            "fn:com.acme.Svc#handle(int)",
                            "fn:com.acme.Svc#handle(java.lang.String,int)")
                    .doesNotHaveDuplicates();
        }

        @Test
        void aCallSiteResolvesToTheSameKeyAsTheDeclaration() {
            // The property every `calls` edge depends on: the key derived from a
            // resolved call target must equal the key derived from the target's own
            // declaration, or edges point at nodes that do not exist.
            String source =
                    """
                    package com.acme;
                    class Svc {
                        Object findById(Long id) { return null; }
                    }
                    class Caller {
                        void go(Svc svc) { svc.findById(1L); }
                    }
                    """;

            CompilationUnit cu = parse(source);

            String declarationKey =
                    NodeKeys.forMethod(
                            cu.findAll(MethodDeclaration.class).stream()
                                    .filter(m -> m.getNameAsString().equals("findById"))
                                    .findFirst()
                                    .orElseThrow()
                                    .resolve());

            String callSiteKey =
                    NodeKeys.forMethod(cu.findAll(MethodCallExpr.class).getFirst().resolve());

            assertThat(callSiteKey).isEqualTo(declarationKey);
        }

        @Test
        void returnTypeIsNotPartOfIdentity() {
            // Section 6.1: a return-type change is the *same* node with a new
            // version. If the key moved, the change would read as delete + create.
            String before =
                    keyOf(
                            """
                            package com.acme;
                            class Svc {
                                String findById(Long id) { return null; }
                            }
                            """,
                            "findById");

            String after =
                    keyOf(
                            """
                            package com.acme;
                            import java.util.Optional;
                            class Svc {
                                Optional<String> findById(Long id) { return null; }
                            }
                            """,
                            "findById");

            assertThat(after).isEqualTo(before);
        }

        @Test
        void parameterNamesAreNotPartOfIdentity() {
            String before =
                    keyOf(
                            """
                            package com.acme;
                            class Svc {
                                void go(String a, int b) {}
                            }
                            """,
                            "go");

            String after =
                    keyOf(
                            """
                            package com.acme;
                            class Svc {
                                void go(String name, int count) {}
                            }
                            """,
                            "go");

            assertThat(after).isEqualTo(before);
        }

        @Test
        void nestedClassesQualifyThroughTheirOuterClass() {
            String key =
                    keyOf(
                            """
                            package com.acme;
                            class Outer {
                                static class Inner {
                                    void handle(Object o) {}
                                }
                            }
                            """,
                            "handle");

            assertThat(key).isEqualTo("fn:com.acme.Outer.Inner#handle(java.lang.Object)");
        }

        @Test
        void defaultPackageClassesHaveNoLeadingDot() {
            String key =
                    keyOf(
                            """
                            class Main {
                                void main(String[] args) {}
                            }
                            """,
                            "main");

            assertThat(key).isEqualTo("fn:Main#main(java.lang.String[])");
        }
    }

    // -----------------------------------------------------------------------
    // Constructors and the unresolved sink
    // -----------------------------------------------------------------------

    @Nested
    @DisplayName("constructors and unresolved targets")
    class Extras {

        @Test
        void constructorsUseTheJvmInitName() {
            ConstructorDeclaration ctor =
                    parse(
                                    """
                                    package com.acme;
                                    class Svc {
                                        Svc(String name, int size) {}
                                    }
                                    """)
                            .findAll(ConstructorDeclaration.class)
                            .getFirst();

            assertThat(NodeKeys.forConstructor(ctor.resolve()))
                    .isEqualTo("fn:com.acme.Svc#<init>(java.lang.String,int)");
        }

        @Test
        void unresolvedTargetsAreNamespaced() {
            assertThat(NodeKeys.unresolved("org.example.Thing#save(java.lang.Object)"))
                    .isEqualTo("unresolved:org.example.Thing#save(java.lang.Object)");
        }
    }

    // -----------------------------------------------------------------------
    // Guards on JavaParser behaviour this class relies on
    // -----------------------------------------------------------------------

    @Nested
    @DisplayName("guards on assumed JavaParser behaviour")
    class ToolchainAssumptions {

        @Test
        void varargsAreAlreadyArraysInTheResolvedType() {
            // NodeKeys#eraseParameter carries a guard that appends "[]" for a
            // variadic parameter. This documents that the guard is belt-and-braces:
            // JavaParser already resolves String... to java.lang.String[]. If this
            // ever fails, the guard has become load-bearing rather than defensive.
            var method =
                    parse(
                                    """
                                    package com.acme;
                                    class Fmt { void join(String sep, String... parts) {} }
                                    """)
                            .findAll(MethodDeclaration.class)
                            .getFirst()
                            .resolve();

            var variadic = method.getParam(1);

            assertThat(variadic.isVariadic()).isTrue();
            assertThat(variadic.getType().isArray()).isTrue();
            assertThat(variadic.getType().describe()).isEqualTo("java.lang.String[]");
        }

        @Test
        void qualifiedSignatureIsNotUsableAsAKeyDirectly() {
            // Why NodeKeys reads parameters structurally instead of parsing
            // getQualifiedSignature(): that rendering puts a space after each comma
            // and writes varargs as "..." rather than "[]". Building keys from it
            // would produce strings that disagree with the canonical form in
            // shared/src/nodeKey.ts — and node identity would silently split in two
            // between the Java producer and the TypeScript consumer.
            var method =
                    parse(
                                    """
                                    package com.acme;
                                    class Fmt { void join(String sep, String... parts) {} }
                                    """)
                            .findAll(MethodDeclaration.class)
                            .getFirst()
                            .resolve();

            assertThat(method.getQualifiedSignature())
                    .isEqualTo("com.acme.Fmt.join(java.lang.String, java.lang.String...)")
                    .isNotEqualTo(NodeKeys.forMethod(method).substring(NodeKeys.FN_PREFIX.length()));

            assertThat(NodeKeys.forMethod(method))
                    .isEqualTo("fn:com.acme.Fmt#join(java.lang.String,java.lang.String[])");
        }
    }
}
