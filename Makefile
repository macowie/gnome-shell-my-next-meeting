NAME=my-next-meeting

schemas/gschemas.compiled: schemas/org.gnome.shell.extensions.$(NAME).gschema.xml
	glib-compile-schemas schemas

$(NAME).zip: schemas/gschemas.compiled
	@cp -r schemas dist/
	@cp extension.js prefs.js util.js deps.js dist/
	@cp metadata.json dist/
	@(cd dist && zip ../$(NAME).zip -9r .)

pack: $(NAME).zip

install: $(NAME).zip
	gnome-extensions install --force $(NAME).zip

clean:
	@rm -rf dist $(NAME).zip