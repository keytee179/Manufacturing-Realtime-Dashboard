from flask import Blueprint, render_template
from .app import create_app
from pathlib import Path
def create_centaur_blueprint():
    base_dir = Path(__file__).resolve().parent
    centaur_app = create_app(base_dir)
    bp = Blueprint(
        "centaur",
        __name__,
        template_folder="templates",
        static_folder="static",
        url_prefix="/NPI_CentaurA"
    )
    @bp.route("/")
    def index():
        return render_template("cen_index.html")
    for rule in centaur_app.url_map.iter_rules():
        if rule.endpoint == "static":
            continue
        bp.add_url_rule(
            rule.rule,
            endpoint=f"centaur_{rule.endpoint}",
            view_func=centaur_app.view_functions[rule.endpoint],
            methods=rule.methods
        )
    return bp
