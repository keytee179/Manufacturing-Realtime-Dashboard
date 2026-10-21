from .app import create_app
def register_eos(app):
    eos_app = create_app()
    for rule in eos_app.url_map.iter_rules():
        if rule.endpoint != "static":
            app.add_url_rule(
                f"/NPI_EOS{rule.rule}",
                endpoint=f"eos_{rule.endpoint}",
                view_func=eos_app.view_functions[rule.endpoint],
                methods=rule.methods
            )
