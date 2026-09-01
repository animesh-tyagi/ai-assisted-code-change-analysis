package com.impact.parser.extract;

import static org.assertj.core.api.Assertions.assertThat;

import com.impact.parser.graph.ParsedFunction;
import com.impact.parser.resolve.SourceAndJdkTypeSolverFactory;
import com.impact.parser.workspace.SourceRootDiscovery;
import com.impact.parser.workspace.WorkspaceLayout;
import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Nested;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

/**
 * Phase 3 behaviour: source-root discovery, function extraction, and the two
 * properties section 8 depends on — determinism, and never losing a node.
 */
class FunctionExtractorTest {

    @TempDir Path tempDir;

    // -----------------------------------------------------------------------
    // Helpers: build a throwaway workspace on disk
    // -----------------------------------------------------------------------

    private Path writeSource(String relativePath, String source) throws IOException {
        Path file = tempDir.resolve(relativePath);
        Files.createDirectories(file.getParent());
        Files.writeString(file, source);
        return file;
    }

    private ExtractionResult extractAll() {
        return extract(null);
    }

    /** Extracts, optionally narrowing to a subset of files (subset mode, D4). */
    private ExtractionResult extract(List<Path> subset) {
        WorkspaceLayout layout = SourceRootDiscovery.discover(tempDir, false);
        var solver = new SourceAndJdkTypeSolverFactory().create(layout);
        List<Path> files = subset != null ? subset : SourceRootDiscovery.javaFiles(layout);
        return new GraphExtractor(solver).extract(layout, files);
    }

    private static ParsedFunction byMethodName(ExtractionResult result, String name) {
        return result.functions().stream()
                .filter(f -> f.methodName().equals(name))
                .findFirst()
                .orElseThrow(() -> new AssertionError("no function named " + name));
    }

    // -----------------------------------------------------------------------
    // Source roots
    // -----------------------------------------------------------------------

    @Nested
    @DisplayName("source root discovery")
    class SourceRoots {

        @Test
        void findsTheConventionalMainRoot() throws IOException {
            writeSource("src/main/java/com/acme/A.java", "package com.acme; class A {}");

            WorkspaceLayout layout = SourceRootDiscovery.discover(tempDir, false);

            assertThat(layout.relativeSourceRoots()).containsExactly("src/main/java");
        }

        @Test
        void excludesTestSourcesByDefault() throws IOException {
            // Q2 in section 16.1: test sources are out of the v1 graph.
            writeSource("src/main/java/com/acme/A.java", "package com.acme; class A {}");
            writeSource("src/test/java/com/acme/ATest.java", "package com.acme; class ATest {}");

            assertThat(SourceRootDiscovery.discover(tempDir, false).relativeSourceRoots())
                    .containsExactly("src/main/java");
            assertThat(SourceRootDiscovery.discover(tempDir, true).relativeSourceRoots())
                    .containsExactly("src/main/java", "src/test/java");
        }

        @Test
        void findsEveryModuleRootInAMultiModuleLayout() throws IOException {
            // Q3: both current validation repos are single-module, so this is a
            // generalisation rather than a used path — asserted so it stays working.
            writeSource("core/src/main/java/com/acme/A.java", "package com.acme; class A {}");
            writeSource("web/src/main/java/com/acme/B.java", "package com.acme; class B {}");

            assertThat(SourceRootDiscovery.discover(tempDir, false).relativeSourceRoots())
                    .containsExactly("core/src/main/java", "web/src/main/java");
        }

        @Test
        void reportsAWorkspaceWithNoJavaSources() throws IOException {
            writeSource("README.md", "no java here");

            assertThat(
                            org.assertj.core.api.Assertions.catchThrowable(
                                    () -> SourceRootDiscovery.discover(tempDir, false)))
                    .isInstanceOf(SourceRootDiscovery.NoSourceRootsException.class);
        }
    }

    // -----------------------------------------------------------------------
    // Extraction
    // -----------------------------------------------------------------------

    @Nested
    @DisplayName("function extraction")
    class Extraction {

        @Test
        void capturesTheFullSection8FieldSet() throws IOException {
            writeSource(
                    "src/main/java/com/acme/UserService.java",
                    """
                    package com.acme;

                    class UserService {
                        @Deprecated
                        public String findById(Long id, int depth) {
                            return String.valueOf(id);
                        }
                    }
                    """);

            ParsedFunction fn = byMethodName(extractAll(), "findById");

            assertThat(fn.key()).isEqualTo("fn:com.acme.UserService#findById(java.lang.Long,int)");
            assertThat(fn.fqcn()).isEqualTo("com.acme.UserService");
            assertThat(fn.className()).isEqualTo("UserService");
            assertThat(fn.paramTypes()).containsExactly("java.lang.Long", "int");
            assertThat(fn.paramNames()).containsExactly("id", "depth");
            assertThat(fn.returnType()).isEqualTo("java.lang.String");
            assertThat(fn.filePath()).isEqualTo("src/main/java/com/acme/UserService.java");
            assertThat(fn.modifiers()).containsExactly("public");
            assertThat(fn.annotations()).extracting(a -> a.name()).containsExactly("Deprecated");
            assertThat(fn.isAbstract()).isFalse();
            assertThat(fn.isInterfaceMethod()).isFalse();
            assertThat(fn.bodyHash()).startsWith("sha256:").hasSize("sha256:".length() + 64);
            // The line range must span the annotation too, so it is usable as-is
            // for `git log -L` (C7).
            assertThat(fn.startLine()).isEqualTo(4);
            assertThat(fn.endLine()).isEqualTo(7);
        }

        @Test
        void filePathsUseForwardSlashesOnEveryPlatform() throws IOException {
            writeSource("src/main/java/com/acme/deep/nested/A.java", "package com.acme.deep.nested; class A { void go() {} }");

            assertThat(byMethodName(extractAll(), "go").filePath())
                    .isEqualTo("src/main/java/com/acme/deep/nested/A.java")
                    .doesNotContain(String.valueOf(WorkspaceLayoutSeparator.BACKSLASH));
        }

        @Test
        void marksInterfaceMethodsAbstractWithoutAnAbstractKeyword() throws IOException {
            writeSource(
                    "src/main/java/com/acme/Strategy.java",
                    """
                    package com.acme;
                    interface Strategy {
                        void execute(String input);
                    }
                    """);

            ParsedFunction fn = byMethodName(extractAll(), "execute");

            assertThat(fn.isInterfaceMethod()).isTrue();
            assertThat(fn.isAbstract()).isTrue();
            assertThat(fn.modifiers()).isEmpty();
        }

        @Test
        void extractsConstructors() throws IOException {
            writeSource(
                    "src/main/java/com/acme/Svc.java",
                    """
                    package com.acme;
                    class Svc {
                        Svc(String name) {}
                    }
                    """);

            assertThat(extractAll().functions())
                    .extracting(ParsedFunction::key)
                    .contains("fn:com.acme.Svc#<init>(java.lang.String)");
        }

        @Test
        void attributesNestedClassMethodsToTheirInnerType() throws IOException {
            writeSource(
                    "src/main/java/com/acme/Outer.java",
                    """
                    package com.acme;
                    class Outer {
                        void go() {}
                        static class Inner {
                            void go() {}
                        }
                    }
                    """);

            assertThat(extractAll().functions())
                    .extracting(ParsedFunction::key)
                    .containsExactly("fn:com.acme.Outer#go()", "fn:com.acme.Outer.Inner#go()");
        }

        @Test
        void readsAnnotationMembersWithStringLiteralsUnquoted() throws IOException {
            writeSource(
                    "src/main/java/com/acme/Ctrl.java",
                    """
                    package com.acme;
                    class Ctrl {
                        @RequestMapping("/api/users")
                        void list() {}
                        @Scheduled(fixedRate = 5000, initialDelay = 10)
                        void tick() {}
                    }
                    """);

            ExtractionResult result = extractAll();

            // Phase 5 concatenates route paths directly, so the quotes must be gone.
            assertThat(byMethodName(result, "list").annotations().getFirst().value())
                    .isEqualTo("/api/users");
            assertThat(byMethodName(result, "tick").annotations().getFirst().values())
                    .containsEntry("fixedRate", "5000")
                    .containsEntry("initialDelay", "10");
        }
    }

    // -----------------------------------------------------------------------
    // The two properties section 8 depends on
    // -----------------------------------------------------------------------

    @Nested
    @DisplayName("never loses a node")
    class Resilience {

        @Test
        void keepsMethodsWhoseParameterTypesCannotBeResolved() throws IOException {
            // The critical case under D2's source+JDK-only resolution. A controller
            // method taking a third-party type must still become a node — if it
            // vanished, it would appear to have no callers and a change to it would
            // look harmless. That is the exact blind spot the tool exists to prevent.
            writeSource(
                    "src/main/java/com/acme/Ctrl.java",
                    """
                    package com.acme;
                    import jakarta.servlet.http.HttpServletRequest;
                    class Ctrl {
                        void handle(HttpServletRequest request) {}
                    }
                    """);

            ExtractionResult result = extractAll();
            ParsedFunction fn = byMethodName(result, "handle");

            // Qualified from the import, not guessed and not dropped.
            assertThat(fn.paramTypes()).containsExactly("jakarta.servlet.http.HttpServletRequest");
            assertThat(fn.key())
                    .isEqualTo("fn:com.acme.Ctrl#handle(jakarta.servlet.http.HttpServletRequest)");
            // ...and the imprecision is counted rather than hidden.
            assertThat(fn.unresolvedParamTypes()).isEqualTo(1);
            assertThat(result.unresolvedParamTypes()).isEqualTo(1);
        }

        @Test
        void leavesAnUnimportedUnknownTypeExactlyAsWritten() throws IOException {
            // No import to qualify from. Inventing a package would produce a
            // confident wrong answer, so the simple name is kept as-is.
            writeSource(
                    "src/main/java/com/acme/Ctrl.java",
                    """
                    package com.acme;
                    import some.pkg.*;
                    class Ctrl {
                        void handle(Mystery thing) {}
                    }
                    """);

            ParsedFunction fn = byMethodName(extractAll(), "handle");

            assertThat(fn.paramTypes()).containsExactly("Mystery");
            assertThat(fn.unresolvedParamTypes()).isEqualTo(1);
        }

        @Test
        void recordsUnparseableFilesInsteadOfSwallowingThem() throws IOException {
            writeSource("src/main/java/com/acme/Good.java", "package com.acme; class Good { void ok() {} }");
            writeSource("src/main/java/com/acme/Bad.java", "package com.acme; class Bad { this is not java");

            ExtractionResult result = extractAll();

            assertThat(result.parseErrors())
                    .singleElement()
                    .extracting(ParseError::filePath)
                    .isEqualTo("src/main/java/com/acme/Bad.java");
            // The rest of the graph is still built.
            assertThat(result.functions()).extracting(ParsedFunction::methodName).contains("ok");
            assertThat(result.filesParsed()).isEqualTo(1);
        }
    }

    @Nested
    @DisplayName("determinism (section 8 purity)")
    class Determinism {

        @Test
        void repeatedExtractionsProduceIdenticalOutput() throws IOException {
            writeSource("src/main/java/com/acme/B.java", "package com.acme; class B { void b() {} void a() {} }");
            writeSource("src/main/java/com/acme/A.java", "package com.acme; class A { void z() {} }");

            assertThat(extractAll()).isEqualTo(extractAll());
        }

        @Test
        void functionsComeBackSortedByKey() throws IOException {
            writeSource(
                    "src/main/java/com/acme/Z.java",
                    "package com.acme; class Z { void zebra() {} void apple() {} }");

            List<String> keys = extractAll().functions().stream().map(ParsedFunction::key).toList();

            assertThat(keys).isSorted();
        }

        @Test
        void reformattingTheBodyDoesNotChangeTheBodyHash() throws IOException {
            writeSource(
                    "src/main/java/com/acme/A.java",
                    "package com.acme; class A { int go() { return 1 + 2; } }");
            String before = byMethodName(extractAll(), "go").bodyHash();

            writeSource(
                    "src/main/java/com/acme/A.java",
                    """
                    package com.acme;
                    class A {
                        int go() {
                                return 1  +  2;
                        }
                    }
                    """);
            String after = byMethodName(extractAll(), "go").bodyHash();

            assertThat(after).isEqualTo(before);
        }

        @Test
        void changingTheBodyDoesChangeTheBodyHash() throws IOException {
            writeSource("src/main/java/com/acme/A.java", "package com.acme; class A { int go() { return 1; } }");
            String before = byMethodName(extractAll(), "go").bodyHash();

            writeSource("src/main/java/com/acme/A.java", "package com.acme; class A { int go() { return 2; } }");

            assertThat(byMethodName(extractAll(), "go").bodyHash()).isNotEqualTo(before);
        }
    }

    // -----------------------------------------------------------------------
    // Subset mode
    // -----------------------------------------------------------------------

    @Nested
    @DisplayName("subset mode (D4)")
    class SubsetMode {

        @Test
        void narrowsExtractionButNotResolution() throws IOException {
            // The property D4 rests on: only touched files are extracted, but the
            // solver still spans the workspace, so a type declared in an untouched
            // file still resolves.
            writeSource(
                    "src/main/java/com/acme/Helper.java",
                    """
                    package com.acme;
                    public class Helper {
                        public String describe() { return "x"; }
                    }
                    """);
            Path touched =
                    writeSource(
                            "src/main/java/com/acme/Caller.java",
                            """
                            package com.acme;
                            class Caller {
                                void go(Helper helper) {}
                            }
                            """);

            ExtractionResult result = extract(List.of(touched));

            assertThat(result.functions()).extracting(ParsedFunction::methodName).containsExactly("go");
            // Helper resolved fully despite not being extracted.
            assertThat(result.functions().getFirst().paramTypes()).containsExactly("com.acme.Helper");
            assertThat(result.unresolvedParamTypes()).isZero();
        }
    }

    // -----------------------------------------------------------------------
    // Regressions found by running against the real validation repos
    // -----------------------------------------------------------------------

    @Nested
    @DisplayName("regressions caught on real code")
    class RealCodeRegressions {

        @Test
        void parsesModernJavaSyntax() throws IOException {
            // Found in observability-final: JavaParser's default language level
            // predates Java 12, so one switch expression made the whole file
            // unparseable and took nine functions with it. Silent node loss is the
            // worst failure mode here — those methods would look uncalled.
            writeSource(
                    "src/main/java/com/acme/Classifier.java",
                    """
                    package com.acme;
                    class Classifier {
                        String classify(String dep) {
                            return switch (dep) {
                                case "DB" -> "db";
                                case "API", "THIRD_PARTY" -> "api";
                                default -> "other";
                            };
                        }
                        String textBlock() {
                            return \"""
                                   hello
                                   \""";
                        }
                    }
                    """);

            ExtractionResult result = extractAll();

            assertThat(result.parseErrors()).isEmpty();
            assertThat(result.functions())
                    .extracting(ParsedFunction::methodName)
                    .containsExactlyInAnyOrder("classify", "textBlock");
        }

        @Test
        void anonymousClassesGetDistinctKeys() throws IOException {
            // Found in petclinic's JdbcVetRepositoryImpl: two anonymous
            // BeanPropertyRowMapper bodies each declaring mapRow(ResultSet,int).
            // Anonymous bodies are not TypeDeclarations, so both were attributed to
            // the enclosing class and collided on one key — which would violate the
            // unique indexes in section 7 and merge two unrelated methods.
            writeSource(
                    "src/main/java/com/acme/Repo.java",
                    """
                    package com.acme;
                    import java.util.concurrent.Callable;
                    class Repo {
                        Callable<String> first() {
                            return new Callable<String>() {
                                public String call() { return "a"; }
                            };
                        }
                        Callable<String> second() {
                            return new Callable<String>() {
                                public String call() { return "b"; }
                            };
                        }
                    }
                    """);

            List<String> keys = extractAll().functions().stream().map(ParsedFunction::key).toList();

            assertThat(keys).doesNotHaveDuplicates();
            assertThat(keys)
                    .contains("fn:com.acme.Repo$1#call()", "fn:com.acme.Repo$2#call()");
        }

        @Test
        void localClassesAreQualifiedThroughTheirEnclosingType() throws IOException {
            // Same family of bug: a class declared inside a method has no qualified
            // name of its own, so two same-named local classes in one file would
            // otherwise collide.
            writeSource(
                    "src/main/java/com/acme/Host.java",
                    """
                    package com.acme;
                    class Host {
                        void one() {
                            class Helper { void go() {} }
                            new Helper().go();
                        }
                    }
                    """);

            assertThat(extractAll().functions())
                    .extracting(ParsedFunction::key)
                    .contains("fn:com.acme.Host$Helper#go()");
        }
    }

    /** Keeps a literal backslash out of the test source. */
    private static final class WorkspaceLayoutSeparator {
        static final char BACKSLASH = (char) 92;
    }
}
