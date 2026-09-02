package com.impact.parser.spring;

import com.github.javaparser.ast.CompilationUnit;
import com.github.javaparser.ast.ImportDeclaration;
import com.github.javaparser.ast.body.BodyDeclaration;
import com.github.javaparser.ast.body.FieldDeclaration;
import com.github.javaparser.ast.body.TypeDeclaration;
import com.github.javaparser.ast.body.VariableDeclarator;
import com.github.javaparser.ast.expr.AnnotationExpr;
import com.github.javaparser.ast.expr.Expression;
import com.github.javaparser.ast.expr.StringLiteralExpr;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.TreeMap;

/**
 * Reading Spring annotations off the raw AST.
 *
 * <p>Matched by <strong>name</strong>, never by resolved type. That is what makes
 * DECISIONS D2 work: Spring's own jars are not on the solver, and never need to
 * be, because {@code @RestController} is recognisable as text. The same choice is
 * why this service can analyse a repository whose Spring version differs from
 * ours — there is no version to disagree about.
 *
 * <p>Where a rule needs more certainty than a bare name gives — telling Spring
 * Data's {@code Repository} from any other type called {@code Repository} — the
 * check is escalated to the compilation unit's imports rather than to type
 * resolution. See {@link #importFor}.
 */
public final class SpringAnnotations {

    private SpringAnnotations() {}

    // Stereotypes. Used to rank interface-dispatch candidates, never to gate
    // whether an implementation exists (§6.4).
    public static final List<String> STEREOTYPES =
            List.of("Service", "Component", "Repository", "Controller", "RestController");

    public static final String PRIMARY = "Primary";
    public static final String QUALIFIER = "Qualifier";

    /** Method-level HTTP mappings, and the verb each implies. */
    public static final Map<String, String> HTTP_MAPPINGS =
            Map.of(
                    "GetMapping", "GET",
                    "PostMapping", "POST",
                    "PutMapping", "PUT",
                    "DeleteMapping", "DELETE",
                    "PatchMapping", "PATCH");

    public static final String REQUEST_MAPPING = "RequestMapping";
    public static final String SCHEDULED = "Scheduled";

    /** Listener annotations and the broker each names, for the surface key. */
    public static final Map<String, String> LISTENERS =
            Map.of(
                    "KafkaListener", "kafka",
                    "RabbitListener", "rabbit",
                    "JmsListener", "jms",
                    "EventListener", "event");

    /** Finds an annotation by simple name. */
    public static Optional<AnnotationExpr> find(BodyDeclaration<?> declaration, String name) {
        return declaration.getAnnotations().stream()
                .filter(a -> a.getName().getIdentifier().equals(name))
                .findFirst();
    }

    public static boolean has(BodyDeclaration<?> declaration, String name) {
        return find(declaration, name).isPresent();
    }

    public static boolean hasAnyStereotype(BodyDeclaration<?> declaration) {
        return STEREOTYPES.stream().anyMatch(name -> has(declaration, name));
    }

    /**
     * Annotation members as a sorted map. String literals arrive unquoted so route
     * paths can be concatenated directly.
     */
    public static Map<String, String> members(AnnotationExpr annotation) {
        Map<String, String> values = new TreeMap<>();
        if (annotation.isSingleMemberAnnotationExpr()) {
            values.put("value", literalOf(annotation.asSingleMemberAnnotationExpr().getMemberValue()));
        } else if (annotation.isNormalAnnotationExpr()) {
            annotation
                    .asNormalAnnotationExpr()
                    .getPairs()
                    .forEach(pair -> values.put(pair.getNameAsString(), literalOf(pair.getValue())));
        }
        return values;
    }

    /**
     * The first member of {@code value}, unwrapping the array form.
     *
     * <p>{@code @RequestMapping({"/a", "/b"})} is legal; v1 takes the first path
     * and does not fan out to one route per alias.
     */
    public static Optional<String> firstValue(AnnotationExpr annotation) {
        Map<String, String> members = members(annotation);
        String value = members.getOrDefault("value", members.get("path"));
        if (value == null || value.isBlank()) {
            return Optional.empty();
        }
        if (value.startsWith("{")) {
            String inner = value.substring(1, value.endsWith("}") ? value.length() - 1 : value.length());
            String first = inner.split(",")[0].trim();
            return Optional.of(unquote(first));
        }
        return Optional.of(value);
    }

    /**
     * A resolved path plus whether it is trustworthy enough to key a route on.
     *
     * @param exact false when the value could not be fully evaluated, in which
     *     case {@code value} is the verbatim source text
     */
    public record PathValue(String value, boolean exact) {}

    /**
     * Resolves a constant reference in an annotation value to its string literal.
     *
     * <p>Generated OpenAPI interfaces write
     * {@code @RequestMapping(value = OwnersApi.PATH_DELETE_OWNER)} rather than an
     * inline path. Left unresolved, every petclinic route key would read
     * {@code /api/OwnersApi.PATH_DELETE_OWNER} — the right count of routes with
     * none of the right paths, which is worse than useless in an explanation.
     *
     * <p>Unlike a {@code ${property}} placeholder, a {@code static final String} is
     * statically knowable, so resolving it is exact rather than a guess.
     *
     * <p><strong>All or nothing.</strong> A value that cannot be fully evaluated —
     * a concatenation, or a constant whose initialiser is not a plain literal — is
     * returned verbatim and marked inexact, never partially substituted. A
     * half-resolved path like {@code /api/} + an unresolved tail looks like a real
     * endpoint and would key a route nobody can find, which is a worse failure
     * than an honestly ambiguous one.
     */
    public static PathValue resolveConstants(BodyDeclaration<?> declaringMember, String value) {
        if (value == null || value.isBlank()) {
            return new PathValue(value == null ? "" : value, true);
        }
        // A literal path is already exact.
        if (value.startsWith("/")) {
            return new PathValue(value, true);
        }
        // A concatenation cannot be evaluated from one field lookup. Refuse rather
        // than substitute the half we can see.
        if (value.contains("+")) {
            return new PathValue(value, false);
        }
        String fieldName = value.contains(".") ? value.substring(value.lastIndexOf('.') + 1) : value;
        if (!fieldName.matches("[A-Z][A-Z0-9_]*")) {
            // Not constant-shaped: an expression we do not model. Verbatim, inexact.
            return new PathValue(value, false);
        }
        return declaringMember
                .findAncestor(TypeDeclaration.class)
                .flatMap(type -> constantValue(type, fieldName))
                .map(resolved -> new PathValue(resolved, true))
                .orElseGet(() -> new PathValue(value, false));
    }

    private static Optional<String> constantValue(TypeDeclaration<?> type, String fieldName) {
        for (FieldDeclaration field : type.getFields()) {
            for (VariableDeclarator variable : field.getVariables()) {
                if (!variable.getNameAsString().equals(fieldName)) {
                    continue;
                }
                return variable
                        .getInitializer()
                        .filter(StringLiteralExpr.class::isInstance)
                        .map(init -> ((StringLiteralExpr) init).asString());
            }
        }
        return Optional.empty();
    }

    private static String literalOf(Expression expression) {
        if (expression instanceof StringLiteralExpr literal) {
            return literal.asString();
        }
        return expression.toString();
    }

    private static String unquote(String value) {
        String trimmed = value.trim();
        if (trimmed.length() >= 2 && trimmed.startsWith("\"") && trimmed.endsWith("\"")) {
            return trimmed.substring(1, trimmed.length() - 1);
        }
        return trimmed;
    }

    /**
     * The import that brings a simple type name into a compilation unit.
     *
     * <p>Used to tell Spring Data's {@code Repository} from anyone else's: the
     * bare name is far too common to match on, but
     * {@code import org.springframework.data.repository.Repository} is decisive.
     * Wildcard imports are skipped — they do not establish which package a name
     * came from, and pretending otherwise would fabricate certainty.
     */
    public static Optional<String> importFor(CompilationUnit cu, String simpleName) {
        for (ImportDeclaration importDecl : cu.getImports()) {
            if (importDecl.isAsterisk() || importDecl.isStatic()) {
                continue;
            }
            String imported = importDecl.getNameAsString();
            if (imported.endsWith("." + simpleName)) {
                return Optional.of(imported);
            }
        }
        return Optional.empty();
    }

    /**
     * Joins a class-level and method-level path into one route path.
     *
     * <p>Normalises to a single leading slash and no trailing slash, so
     * {@code "/api"} + {@code "owners/"} and {@code "/api/"} + {@code "/owners"}
     * produce the same key — otherwise one route would become two nodes.
     */
    public static String joinPaths(String classPath, String methodPath) {
        String joined = trimSlashes(classPath) + "/" + trimSlashes(methodPath);
        String collapsed = joined.replaceAll("/+", "/");
        String trimmed = trimSlashes(collapsed);
        return "/" + trimmed;
    }

    private static String trimSlashes(String value) {
        if (value == null) {
            return "";
        }
        String result = value.trim();
        while (result.startsWith("/")) {
            result = result.substring(1);
        }
        while (result.endsWith("/")) {
            result = result.substring(0, result.length() - 1);
        }
        return result;
    }
}
