package com.impact.parser.spring;

import static org.assertj.core.api.Assertions.assertThat;

import com.impact.parser.extract.ExtractionResult;
import com.impact.parser.extract.GraphExtractor;
import com.impact.parser.graph.EdgeType;
import com.impact.parser.graph.GraphEdge;
import com.impact.parser.graph.SurfaceKind;
import com.impact.parser.resolve.SourceAndJdkTypeSolverFactory;
import com.impact.parser.workspace.SourceRootDiscovery;
import com.impact.parser.workspace.WorkspaceLayout;
import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.Deque;
import java.util.HashSet;
import java.util.List;
import java.util.Set;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

/**
 * The acceptance criterion for the Spring Data rule is <strong>composition</strong>,
 * not edge count.
 *
 * <p>A large {@code queries} count proves nothing if the edges hang off a node no
 * caller resolves to. What matters is that the chain closes:
 *
 * <pre>
 * entity:Owner ← queries ← OwnerRepository#findByLastName
 *              ← calls   ← ClinicService#findOwner
 *              ← calls   ← OwnerController#get
 *              ← handles ← route:GET /api/owners/{id}
 * </pre>
 *
 * <p>This mirrors petclinic's real shape: the Spring Data marker sits on a
 * sub-interface that declares nothing, while callers hold the plain domain
 * interface. Attaching {@code queries} to the marker would leave the entity
 * stranded and this test red.
 */
class SpringDataCompositionTest {

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

    /** Everything that reaches {@code start} by walking edges backwards. */
    private static Set<String> reverseReachable(ExtractionResult result, String start) {
        Set<String> seen = new HashSet<>();
        Deque<String> queue = new ArrayDeque<>();
        queue.add(start);
        while (!queue.isEmpty()) {
            String current = queue.poll();
            for (GraphEdge edge : result.edges()) {
                if (edge.to().equals(current) && seen.add(edge.from())) {
                    queue.add(edge.from());
                }
            }
        }
        return seen;
    }

    private void writePetclinicShape() throws IOException {
        // The entity, with an explicit table name.
        writeSource(
                "src/main/java/com/acme/model/Owner.java",
                """
                package com.acme.model;
                @Entity
                @Table(name = "owners")
                public class Owner {
                    private String lastName;
                    public String getLastName() { return lastName; }
                }
                """);
        // The plain domain interface callers actually hold — declares the methods.
        writeSource(
                "src/main/java/com/acme/repository/OwnerRepository.java",
                """
                package com.acme.repository;
                import com.acme.model.Owner;
                import java.util.Collection;
                public interface OwnerRepository {
                    Collection<Owner> findByLastName(String lastName);
                    void save(Owner owner);
                }
                """);
        // The Spring Data marker sub-interface — declares NOTHING. This is the
        // shape that makes attachment-point choice load-bearing.
        writeSource(
                "src/main/java/com/acme/repository/springdatajpa/SpringDataOwnerRepository.java",
                """
                package com.acme.repository.springdatajpa;
                import com.acme.model.Owner;
                import com.acme.repository.OwnerRepository;
                import org.springframework.data.repository.Repository;
                public interface SpringDataOwnerRepository
                        extends OwnerRepository, Repository<Owner, Integer> {
                }
                """);
        writeSource(
                "src/main/java/com/acme/service/ClinicService.java",
                """
                package com.acme.service;
                import com.acme.model.Owner;
                import com.acme.repository.OwnerRepository;
                import java.util.Collection;
                public class ClinicService {
                    private final OwnerRepository ownerRepository;
                    public ClinicService(OwnerRepository ownerRepository) {
                        this.ownerRepository = ownerRepository;
                    }
                    public Collection<Owner> findOwner(String lastName) {
                        return ownerRepository.findByLastName(lastName);
                    }
                }
                """);
        writeSource(
                "src/main/java/com/acme/rest/OwnerController.java",
                """
                package com.acme.rest;
                import com.acme.model.Owner;
                import com.acme.service.ClinicService;
                import java.util.Collection;
                @RestController
                @RequestMapping("/api")
                public class OwnerController {
                    private final ClinicService service;
                    public OwnerController(ClinicService service) { this.service = service; }
                    @GetMapping("/owners/{lastName}")
                    public Collection<Owner> get(String lastName) {
                        return service.findOwner(lastName);
                    }
                }
                """);
    }

    @Test
    @DisplayName("entity:Owner reverse-reaches the controller and its route")
    void theChainClosesFromEntityToRoute() throws IOException {
        writePetclinicShape();

        ExtractionResult result = extract();
        Set<String> reachable = reverseReachable(result, "entity:com.acme.model.Owner");

        // Each link named individually, so a break points at the guilty edge
        // rather than just failing the whole chain.
        assertThat(reachable)
                .as("queries: the repository method the caller actually resolves to")
                .contains("fn:com.acme.repository.OwnerRepository#findByLastName(java.lang.String)");
        assertThat(reachable)
                .as("calls: the service")
                .contains("fn:com.acme.service.ClinicService#findOwner(java.lang.String)");
        assertThat(reachable)
                .as("calls: the controller")
                .contains("fn:com.acme.rest.OwnerController#get(java.lang.String)");
        assertThat(reachable)
                .as("handles: the route — the terminal surface reverse traversal collapses to")
                .contains("route:GET /api/owners/{lastName}");
    }

    @Test
    @DisplayName("queries attaches to the resolvable declaration, not the empty marker")
    void queriesDoNotHangOffTheMarkerInterfaceAlone() throws IOException {
        writePetclinicShape();

        List<GraphEdge> queries =
                new ArrayList<>(
                        extract().edges().stream().filter(e -> e.type() == EdgeType.QUERIES).toList());

        assertThat(queries).isNotEmpty();
        // The marker declares no methods, so every edge must come from the domain
        // interface. An edge count that looked healthy while pointing only at the
        // marker would be the failure this guards against.
        assertThat(queries)
                .extracting(GraphEdge::from)
                .allSatisfy(from -> assertThat(from).contains("OwnerRepository"));
        assertThat(queries).extracting(GraphEdge::to).containsOnly("entity:com.acme.model.Owner");
    }

    @Test
    @DisplayName("entity maps to its @Table name, and both are surfaces")
    void entityAndTableSurfaces() throws IOException {
        writePetclinicShape();

        ExtractionResult result = extract();

        assertThat(result.surfaces())
                .filteredOn(s -> s.kind() == SurfaceKind.ENTITY)
                .extracting(s -> s.key())
                .contains("entity:com.acme.model.Owner");
        assertThat(result.surfaces())
                .filteredOn(s -> s.kind() == SurfaceKind.TABLE)
                .extracting(s -> s.key())
                .contains("table:owners");
        assertThat(result.edges())
                .filteredOn(e -> e.type() == EdgeType.MAPS_TO)
                .extracting(GraphEdge::to)
                .contains("table:owners");
    }

    @Test
    @DisplayName("a type called Repository from another package is not Spring Data")
    void detectionIsGatedOnTheImport() throws IOException {
        writeSource(
                "src/main/java/com/acme/other/Repository.java",
                "package com.acme.other; public interface Repository<T, ID> {}");
        writeSource(
                "src/main/java/com/acme/other/Thing.java",
                "package com.acme.other; public class Thing {}");
        writeSource(
                "src/main/java/com/acme/other/ThingRepository.java",
                """
                package com.acme.other;
                public interface ThingRepository extends Repository<Thing, Integer> {
                    Thing findById(int id);
                }
                """);

        // "Repository" is far too common a name to match on. Only the resolved
        // import makes it Spring Data.
        assertThat(extract().edges()).noneMatch(e -> e.type() == EdgeType.QUERIES);
    }

    @Test
    @DisplayName("table name defaults to the camel-case convention when unannotated")
    void defaultTableNaming() {
        assertThat(SpringDataRules.camelToUnderscores("UserAccount")).isEqualTo("user_account");
        assertThat(SpringDataRules.camelToUnderscores("Owner")).isEqualTo("owner");
    }

    @Test
    @DisplayName("access comes from the verb, and an unknown verb says so")
    void accessFromVerb() {
        assertThat(SpringDataRules.accessOf("save")).isEqualTo("write");
        assertThat(SpringDataRules.accessOf("deleteByLastName")).isEqualTo("write");
        assertThat(SpringDataRules.accessOf("findByLastName")).isEqualTo("read");
        assertThat(SpringDataRules.accessOf("countByStatus")).isEqualTo("read");
        // Not evidence of either — understating a possible write would be worse
        // than admitting ignorance.
        assertThat(SpringDataRules.accessOf("frobnicate")).isEqualTo("unknown");
    }
}
