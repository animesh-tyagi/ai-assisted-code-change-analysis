package com.impact.parser.spring;

import com.github.javaparser.ast.CompilationUnit;
import com.github.javaparser.ast.body.ClassOrInterfaceDeclaration;
import com.github.javaparser.ast.body.MethodDeclaration;
import com.github.javaparser.ast.body.TypeDeclaration;
import com.github.javaparser.ast.type.ClassOrInterfaceType;
import com.github.javaparser.ast.type.Type;
import com.impact.parser.graph.CallSite;
import com.impact.parser.graph.Confidence;
import com.impact.parser.graph.EdgeCollector;
import com.impact.parser.graph.EdgeType;
import com.impact.parser.graph.SurfaceCollector;
import com.impact.parser.graph.SurfaceKind;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.Locale;
import java.util.Map;
import java.util.Optional;
import java.util.Set;
import java.util.function.Function;

/**
 * Spring Data repositories: which entity a repository method touches, and which
 * table that entity maps to (ARCHITECTURE.md §6.4).
 *
 * <p><strong>Detection</strong> matches the whole family rooted at
 * {@code org.springframework.data.repository.Repository<T,ID>} —
 * {@code CrudRepository}, {@code PagingAndSortingRepository} and
 * {@code JpaRepository} all extend it. Matching only the popular subclasses finds
 * nothing in {@code spring-petclinic-rest}, which uses the base marker
 * throughout. Gated on the supertype's <em>import</em>, never on the bare name
 * {@code Repository}, which is far too common to match safely.
 *
 * <p><strong>Where the edge attaches</strong> is the part that makes the graph
 * compose. The marker usually sits on a sub-interface that declares nothing:
 *
 * <pre>
 * public interface SpringDataOwnerRepository
 *         extends OwnerRepository, Repository&lt;Owner, Integer&gt; { }
 * </pre>
 *
 * Callers hold {@code OwnerRepository} — the plain in-repo interface — so their
 * calls resolve to {@code OwnerRepository#findByLastName}. Attaching
 * {@code queries} to the marker would strand the entity behind a node nothing
 * resolves to. So {@code T} is read from the marker, but the edges attach to the
 * in-repo method declarations reachable through its super-interface chain, which
 * is what closes the chain:
 *
 * <pre>
 * entity:Owner ← queries ← OwnerRepository#findByLastName ← calls ← ClinicServiceImpl ← …
 * </pre>
 */
public final class SpringDataRules {

    private static final String SPRING_DATA_PACKAGE = "org.springframework.data.repository";

    /** The family root plus its well-known subinterfaces. */
    private static final Set<String> MARKER_NAMES =
            Set.of("Repository", "CrudRepository", "PagingAndSortingRepository", "JpaRepository");

    private static final Set<String> WRITE_VERBS = Set.of("save", "delete", "remove", "persist", "insert", "update");
    private static final Set<String> READ_VERBS =
            Set.of("find", "get", "read", "query", "exists", "count", "stream", "search");

    private final EdgeCollector edges;
    private final SurfaceCollector surfaces;

    /** Entity FQCN -> its declaration, gathered so tables can be resolved. */
    private final Map<String, ClassOrInterfaceDeclaration> entityDeclarations = new LinkedHashMap<>();

    public SpringDataRules(EdgeCollector edges, SurfaceCollector surfaces) {
        this.edges = edges;
        this.surfaces = surfaces;
    }

    /** First pass: remember every type, so an entity's {@code @Table} can be read later. */
    public void indexTypes(CompilationUnit cu) {
        for (ClassOrInterfaceDeclaration type : cu.findAll(ClassOrInterfaceDeclaration.class)) {
            type.getFullyQualifiedName().ifPresent(fqcn -> entityDeclarations.put(fqcn, type));
        }
    }

    /** Second pass: emit {@code queries} and {@code maps_to} for repository interfaces. */
    public void apply(
            CompilationUnit cu, String relativePath, Function<MethodDeclaration, String> keyOf) {
        for (ClassOrInterfaceDeclaration type : cu.findAll(ClassOrInterfaceDeclaration.class)) {
            if (!type.isInterface()) {
                continue;
            }
            Optional<String> entity = entityTypeOf(cu, type);
            if (entity.isEmpty()) {
                continue;
            }
            String entityFqcn = entity.get();
            emitEntityAndTable(entityFqcn, relativePath);

            for (MethodDeclaration method : repositoryMethods(type)) {
                String methodKey = keyOf.apply(method);
                CallSite site =
                        new CallSite(relativePath, method.getBegin().map(p -> p.line).orElse(0));
                // @Query methods carry their target in a string; the derived-name
                // path is structural. Both produce the same edge, at different
                // confidence, so the explanation can say which it was.
                Confidence confidence =
                        SpringAnnotations.has(method, "Query") ? Confidence.REGEX : Confidence.EXACT;
                edges.add(
                        methodKey, "entity:" + entityFqcn, EdgeType.QUERIES, true, confidence, site);
            }
        }
    }

    // -----------------------------------------------------------------------
    // Detection
    // -----------------------------------------------------------------------

    /**
     * The entity type argument, if this interface extends a Spring Data marker.
     *
     * <p>Gated on the import so that someone else's {@code Repository} does not
     * match. Wildcard imports do not establish a package, so an unimported
     * {@code Repository} is not treated as Spring Data.
     */
    private static Optional<String> entityTypeOf(CompilationUnit cu, ClassOrInterfaceDeclaration type) {
        for (ClassOrInterfaceType extended : type.getExtendedTypes()) {
            String simpleName = extended.getNameAsString();
            if (!MARKER_NAMES.contains(simpleName)) {
                continue;
            }
            boolean fromSpringData =
                    SpringAnnotations.importFor(cu, simpleName)
                            .map(imported -> imported.startsWith(SPRING_DATA_PACKAGE))
                            .orElse(false);
            if (!fromSpringData) {
                continue;
            }
            Optional<String> entity =
                    extended
                            .getTypeArguments()
                            .filter(args -> !args.isEmpty())
                            .map(args -> args.get(0))
                            .flatMap(SpringDataRules::qualifiedNameOf);
            if (entity.isPresent()) {
                return entity;
            }
        }
        return Optional.empty();
    }

    private static Optional<String> qualifiedNameOf(Type type) {
        try {
            return Optional.of(type.resolve().asReferenceType().getQualifiedName());
        } catch (RuntimeException e) {
            // Unresolvable entity type — fall back to the written name rather than
            // dropping the repository entirely.
            return Optional.of(type.asString());
        }
    }

    /**
     * Methods a caller could resolve to on this repository.
     *
     * <p>Its own declarations plus every method declared on its <em>in-repo</em>
     * super-interfaces. The second half is the important one: petclinic's marker
     * interfaces declare little or nothing, and callers hold the plain domain
     * interface, so attaching only to the marker's own methods would produce a
     * near-empty {@code queries} set that never composes with any call edge.
     */
    private static Set<MethodDeclaration> repositoryMethods(ClassOrInterfaceDeclaration repository) {
        Set<MethodDeclaration> methods = new LinkedHashSet<>(repository.getMethods());
        for (var ancestor : Supertypes.safeAncestors(repository)) {
            ancestor
                    .getTypeDeclaration()
                    .flatMap(declaration -> declaration.toAst())
                    .filter(ClassOrInterfaceDeclaration.class::isInstance)
                    .map(ClassOrInterfaceDeclaration.class::cast)
                    // The framework marker itself contributes no in-repo node.
                    .filter(declaration -> !MARKER_NAMES.contains(declaration.getNameAsString()))
                    .ifPresent(declaration -> methods.addAll(declaration.getMethods()));
        }
        return methods;
    }

    // -----------------------------------------------------------------------
    // Entity and table surfaces
    // -----------------------------------------------------------------------

    private void emitEntityAndTable(String entityFqcn, String relativePath) {
        String entityKey = "entity:" + entityFqcn;
        surfaces.add(entityKey, SurfaceKind.ENTITY, Map.of("fqcn", entityFqcn));

        ClassOrInterfaceDeclaration declaration = entityDeclarations.get(entityFqcn);
        String tableName = tableNameFor(entityFqcn, declaration);
        String tableKey = "table:" + tableName;
        surfaces.add(tableKey, SurfaceKind.TABLE, Map.of("tableName", tableName));

        // An explicit @Table(name=…) is a fact; a defaulted name is a convention we
        // applied, and the confidence says which.
        Confidence confidence =
                declaration != null && explicitTableName(declaration).isPresent()
                        ? Confidence.EXACT
                        : Confidence.SINGLE_IMPL;
        edges.add(
                entityKey, tableKey, EdgeType.MAPS_TO, true, confidence, new CallSite(relativePath, 0));
    }

    private static Optional<String> explicitTableName(TypeDeclaration<?> entity) {
        Optional<String> fromTable =
                SpringAnnotations.find(entity, "Table")
                        .map(SpringAnnotations::members)
                        .map(members -> members.get("name"))
                        .filter(name -> name != null && !name.isBlank());
        if (fromTable.isPresent()) {
            return fromTable;
        }
        return SpringAnnotations.find(entity, "Entity")
                .map(SpringAnnotations::members)
                .map(members -> members.get("name"))
                .filter(name -> name != null && !name.isBlank());
    }

    private static String tableNameFor(String entityFqcn, TypeDeclaration<?> declaration) {
        if (declaration != null) {
            Optional<String> explicit = explicitTableName(declaration);
            if (explicit.isPresent()) {
                return explicit.get();
            }
        }
        String simpleName = entityFqcn.substring(entityFqcn.lastIndexOf('.') + 1);
        return camelToUnderscores(simpleName);
    }

    /** Spring Boot's default {@code CamelCaseToUnderscoresNamingStrategy}. */
    static String camelToUnderscores(String name) {
        StringBuilder result = new StringBuilder(name.length() + 4);
        for (int i = 0; i < name.length(); i++) {
            char c = name.charAt(i);
            if (Character.isUpperCase(c) && i > 0) {
                result.append('_');
            }
            result.append(Character.toLowerCase(c));
        }
        return result.toString().toLowerCase(Locale.ROOT);
    }

    // -----------------------------------------------------------------------
    // Access
    // -----------------------------------------------------------------------

    /** Read or write, taken from the method's leading verb. */
    static String accessOf(String methodName) {
        String lower = methodName.toLowerCase(Locale.ROOT);
        for (String verb : WRITE_VERBS) {
            if (lower.startsWith(verb)) {
                return "write";
            }
        }
        for (String verb : READ_VERBS) {
            if (lower.startsWith(verb)) {
                return "read";
            }
        }
        // An unrecognised verb is not evidence of either; say so rather than
        // defaulting to read and understating a possible write.
        return "unknown";
    }
}
