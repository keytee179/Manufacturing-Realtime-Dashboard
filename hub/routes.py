# hub/routes.py
from flask import Blueprint, render_template
hub_bp = Blueprint(
    "hub",
    __name__,
    template_folder="templates",
    static_folder="static",
    static_url_path="/hub-static"
)
@hub_bp.route("/")
def hub():
    return render_template("hub.html")
