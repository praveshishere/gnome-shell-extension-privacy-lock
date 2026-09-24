UUID = privacy-lock@praveshishere.github.io
INSTALL_DIR = $(HOME)/.local/share/gnome-shell/extensions/$(UUID)
SCHEMA_DIR = $(UUID)/schemas
SCHEMA = schemas/org.gnome.shell.extensions.privacy-lock.gschema.xml

.PHONY: all schemas pack install uninstall enable disable lint clean

all: pack

# Compile schemas in-tree so a local run behaves like the packed bundle.
schemas:
	glib-compile-schemas $(SCHEMA_DIR)

# Produces $(UUID).shell-extension.zip.
pack:
	gnome-extensions pack $(UUID) \
		--schema=$(SCHEMA) \
		--extra-source=lockUI.js \
		--extra-source=pinStore.js \
		--force

install: pack
	gnome-extensions install --force $(UUID).shell-extension.zip
	@echo
	@echo "Installed. GNOME Shell caches JS modules for the life of the"
	@echo "process, so on Wayland you must log out and back in before"
	@echo "enabling - disable/enable alone will not load the new code."

uninstall:
	gnome-extensions uninstall $(UUID) || rm -rf $(INSTALL_DIR)

enable:
	gnome-extensions enable $(UUID)

disable:
	gnome-extensions disable $(UUID)

# Catches syntax errors without a shell reload. Not a substitute for running
# it; GJS-only globals are unknown to node.
lint:
	@for f in $(UUID)/*.js; do node --input-type=module --check < "$$f" \
		&& echo "ok   $$f" || exit 1; done

clean:
	rm -f $(UUID).shell-extension.zip $(SCHEMA_DIR)/gschemas.compiled
