from flask import Blueprint, render_template
from .app import create_app
from pathlib import Path
def create_eos_blueprint():
    base_dir = Path(__file__).resolve().parent
    eos_app = create_app(base_dir)
    bp = Blueprint(
        "eos",
        __name__,
        template_folder="templates",
        static_folder="static",
        url_prefix="/NPI_EOS"
    )
    @bp.route("/")
    def index():
        return render_template("eos_index.html")
    for rule in eos_app.url_map.iter_rules():
        if rule.endpoint in ("static", "index"):
            continue
        bp.add_url_rule(
            rule.rule,
            endpoint=f"eos_{rule.endpoint}",
            view_func=eos_app.view_functions[rule.endpoint],
            methods=rule.methods
        )
    return bp
