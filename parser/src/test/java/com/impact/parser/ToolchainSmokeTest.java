package com.impact.parser;

import static org.assertj.core.api.Assertions.assertThat;

import com.github.javaparser.JavaParser;
import com.github.javaparser.ParserConfiguration;
import com.github.javaparser.ast.CompilationUnit;
import com.github.javaparser.ast.expr.MethodCallExpr;
import com.github.javaparser.resolution.declarations.ResolvedMethodDeclaration;
import com.github.javaparser.symbolsolver.JavaSymbolSolver;
import com.github.javaparser.symbolsolver.resolution.typesolvers.CombinedTypeSolver;
import com.github.javaparser.symbolsolver.resolution.typesolvers.ReflectionTypeSolver;
import org.junit.jupiter.api.Test;

/**
 * Proves the load-bearing toolchain assumption before anything is built on it:
 * JavaSymbolSolver really does resolve a call to a fully-qualified signature.
 *
 * <p>This is the whole reason CLAUDE.md rule 2 forbids tree-sitter — a syntax tree
 * alone cannot do what is asserted below. If this test ever fails, the Spring
 * implicit-edge rules cannot work either, and it should be fixed before anything
 * downstream is touched.
 */
class ToolchainSmokeTest {

    private static JavaParser configuredParser() {
        CombinedTypeSolver typeSolver = new CombinedTypeSolver(new ReflectionTypeSolver());
        ParserConfiguration config =
                new ParserConfiguration().setSymbolResolver(new JavaSymbolSolver(typeSolver));
        return new JavaParser(config);
    }

    private static CompilationUnit parse(String source) {
        return configuredParser().parse(source).getResult().orElseThrow();
    }

    @Test
    void resolvesACallOnAJdkTypeToItsQualifiedSignature() {
        CompilationUnit cu =
                parse(
                        """
                        class Sample {
                            int run(String text) {
                                return text.indexOf("x");
                            }
                        }
                        """);

        MethodCallExpr call = cu.findAll(MethodCallExpr.class).getFirst();
        ResolvedMethodDeclaration resolved = call.resolve();

        // getQualifiedSignature() is the raw material for the node key of
        // ARCHITECTURE section 6.1. Phase 2 normalises it into `fn:...` form.
        assertThat(resolved.getQualifiedSignature()).isEqualTo("java.lang.String.indexOf(java.lang.String)");
    }

    @Test
    void picksTheCorrectOverloadWhenArgumentTypesAreKnown() {
        // Overload selection is exactly what a syntax-only parser cannot do, and
        // what section 6.6 degrades gracefully when argument types are unresolved.
        CompilationUnit cu =
                parse(
                        """
                        class Sample {
                            int run(String text) {
                                return text.indexOf(65);
                            }
                        }
                        """);

        ResolvedMethodDeclaration resolved = cu.findAll(MethodCallExpr.class).getFirst().resolve();

        assertThat(resolved.getQualifiedSignature()).isEqualTo("java.lang.String.indexOf(int)");
    }

    @Test
    void readsAnnotationNamesOffTheRawAst() {
        // Spring's implicit edges are matched by annotation *name* off the raw AST
        // (DECISIONS D2), which is why source+JDK resolution suffices and Spring's
        // own types never need to be on the classpath.
        CompilationUnit cu =
                parse(
                        """
                        @RestController
                        @RequestMapping("/api/owners")
                        class OwnerController {
                        }
                        """);

        assertThat(cu.getType(0).getAnnotations())
                .extracting(a -> a.getName().asString())
                .containsExactly("RestController", "RequestMapping");
    }
}
