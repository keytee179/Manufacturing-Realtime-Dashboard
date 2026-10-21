from flask import Flask
from hub.routes import hub_bp
from CentaurA.blueprint import create_centaur_blueprint
from EOS.blueprint import create_eos_blueprint
from Peridot.blueprint import create_peridot_blueprint
from pathlib import Path
BASE_DIR = Path(__file__).resolve().parent
app = Flask(__name__)
app.register_blueprint(hub_bp)
app.register_blueprint(create_centaur_blueprint())
app.register_blueprint(create_eos_blueprint())
app.register_blueprint(create_peridot_blueprint())
if __name__ == "__main__":
    app.run(host="0.0.0.0", port=5000)
