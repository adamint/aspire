import { useEffect, useState } from "react";
import "./App.css";

function App() {
    const [forecasts, setForecasts] = useState([]);
    const [apiSource, setApiSource] = useState("dotnet"); // "dotnet" or "nodejs"
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState(null);

    const requestWeather = async () => {
        setLoading(true);
        setError(null);
        
        try {
            // Use different endpoints based on selected API
            const endpoint = apiSource === "nodejs" ? "nodeapi/weatherforecast" : "api/weatherforecast";
            const weather = await fetch(endpoint);
            
            if (!weather.ok) {
                throw new Error(`HTTP error! status: ${weather.status}`);
            }
            
            console.log(weather);

            const weatherJson = await weather.json();
            console.log(weatherJson);

            setForecasts(weatherJson);
        } catch (err) {
            console.error("Error fetching weather:", err);
            setError(err.message);
            setForecasts([]);
        } finally {
            setLoading(false);
        }
    };

    useEffect(() => {
        requestWeather();
    }, [apiSource]); // Refetch when API source changes

    const toggleApiSource = () => {
        setApiSource(prev => prev === "dotnet" ? "nodejs" : "dotnet");
    };

    return (
        <div className="App">
            <header className="App-header">
                <h1>React Weather</h1>
                
                <div style={{ marginBottom: "20px" }}>
                    <button 
                        onClick={toggleApiSource}
                        style={{
                            padding: "10px 20px",
                            fontSize: "16px",
                            backgroundColor: apiSource === "dotnet" ? "#61dafb" : "#68d391",
                            border: "none",
                            borderRadius: "5px",
                            cursor: "pointer",
                            color: "black"
                        }}
                    >
                        Using: {apiSource === "dotnet" ? ".NET MinimalAPI" : "Node.js Express"} 
                        (Click to switch)
                    </button>
                </div>

                {loading && <p>Loading weather data...</p>}
                {error && <p style={{color: "red"}}>Error: {error}</p>}

                <table>
                    <thead>
                    <tr>
                        <th>Date</th>
                        <th>Temp. (C)</th>
                        <th>Temp. (F)</th>
                        <th>Summary</th>
                    </tr>
                    </thead>
                    <tbody>
                    {(
                        forecasts ?? [
                            {
                                date: "N/A",
                                temperatureC: "",
                                temperatureF: "",
                                summary: "No forecasts",
                            },
                        ]
                    ).map((w) => {
                        return (
                            <tr key={w.date}>
                                <td>{w.date}</td>
                                <td>{w.temperatureC}</td>
                                <td>{w.temperatureF}</td>
                                <td>{w.summary}</td>
                            </tr>
                        );
                    })}
                    </tbody>
                </table>
            </header>
        </div>
    );
}

export default App;
