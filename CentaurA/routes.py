from .app import create_app
def register_centaur(app):
    centaur_app = create_app()
    for rule in centaur_app.url_map.iter_rules():
        if rule.endpoint != "static":
            app.add_url_rule(
                f"/NPI_CentaurA{rule.rule}",
                endpoint=f"centaur_{rule.endpoint}",
                view_func=centaur_app.view_functions[rule.endpoint],
                methods=rule.methods
            )
