from sqlalchemy import create_engine, Column, Integer, Float
from sqlalchemy.orm import sessionmaker
from sqlalchemy.ext.declarative import declarative_base
import logging
from sklearn.ensemble import IsolationForest
import pandas as pd
import numpy as np
import os

# Configure logging
logging.basicConfig(filename='app.log', filemode='w', 
                   format='%(name)s - %(levelname)s - %(message)s')

Base = declarative_base()
engine = create_engine("sqlite:///data.db")
Session = sessionmaker(bind=engine)

class Reading(Base):
    __tablename__ = "readings"
    id = Column(Integer, primary_key=True)
    value = Column(Float)

# CREATE TABLES BEFORE ANY OPERATIONS
def init_db():
    Base.metadata.create_all(engine)

def process_sensors(data):
    try:
        # Validate input data
        if not isinstance(data, list) or not all(isinstance(item, dict) for item in data):
            logging.error("Invalid input data")
            return "Error: Invalid input data"

        session = Session()
        readings = []

        for item in data:
            for j in range(10):
                if not isinstance(item["value"], (int, float)):
                    logging.error("Invalid value: %s", item["value"])
                    continue

                readings.append(Reading(value=item["value"]))

        session.bulk_save_objects(readings)
        session.commit()
        return "Done"

    except Exception as e:
        session.rollback()
        logging.error("Process error: %s", e)
        return f"Error: {str(e)}"
    finally:
        session.close()

def detect_outliers(data):
    try:
        if not isinstance(data, list) or not all(isinstance(item, dict) for item in data):
            logging.error("Invalid input data")
            return "Error: Invalid input data"

        df = pd.DataFrame(data)
        isolation_forest = IsolationForest(contamination=0.01)
        isolation_forest.fit(df[["value"]])
        outliers = df[isolation_forest.predict(df[["value"]]) == -1]
        return outliers.to_dict(orient="records")

    except Exception as e:
        logging.error("Detection error: %s", e)
        return f"Error: {str(e)}"

if __name__ == "__main__":
    # Initialize database (creates tables)
    init_db()

    # Generate sample data
    np.random.seed(0)
    data = [{"value": np.random.normal(0, 1)} for _ in range(10000)]  # Reduced for testing

    # Process data
    print("Processing...")
    result = process_sensors(data)
    print(result)

    # Detect outliers
    print("Detecting outliers...")
    print(detect_outliers(data))