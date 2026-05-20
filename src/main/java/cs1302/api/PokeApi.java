package cs1302.api;

import cs1302.omega.PokeResponse;
import cs1302.omega.PokeResult;
import cs1302.omega.OmegaApp;
import cs1302.api.APODApi;

import java.util.Random;

import java.net.http.HttpClient;
import javafx.application.Application;
import javafx.application.Platform;
import javafx.event.ActionEvent;
import javafx.event.EventHandler;
import javafx.scene.layout.HBox;
import javafx.scene.layout.Priority;
import javafx.scene.layout.TilePane;
import javafx.scene.image.Image;
import javafx.scene.image.ImageView;
import com.google.gson.Gson;
import com.google.gson.GsonBuilder;
import java.io.IOException;
import java.io.InputStream;
import java.net.URI;
import java.net.URL;
import java.net.URLEncoder;
import java.net.http.HttpResponse;
import java.net.http.HttpResponse.BodyHandlers;
import java.net.http.HttpRequest;
import java.nio.charset.StandardCharsets;

/**This class is used to get the correct APOD Image corrresponding
 * to the user's birthday.
 */
public class PokeApi {

    public static String[] names = new String[20];
    public static String pokemonColor =
        APODApi.getColor(cs1302.omega.OmegaApp.date, false);
    public static String pokemonName;

    /** HTTP client. */
    public static final HttpClient HTTP_CLIENT = HttpClient.newBuilder()
        .version(HttpClient.Version.HTTP_2)           // uses HTTP protocol version 2 where possible
        .followRedirects(HttpClient.Redirect.NORMAL)  // always redirects, except from HTTPS to HTTP
        .build();                                     // builds and returns a HttpClient object

    /** Google {@code Gson} object for parsing JSON-formatted strings. */
    public static Gson GSON = new GsonBuilder()
        .setPrettyPrinting()
        .create();

    private static final String POKE_API  =
        "https://pokeapi.co/api/v2/pokemon-color/";
    private static String color;
    public static String uri;

    /**
     * Get the picture that corresponds to the right date.
     * @param date value is passed here to get back to application class.
     * @param getApod discerns whether this is used to make an APOD image.
     */
    public static void pictureGet(String date, boolean getApod) {

        try {

            color = APODApi.getColor(date, getApod);
            uri = POKE_API + color;

            // build request
            HttpRequest request = HttpRequest.newBuilder()
                .uri(URI.create(uri))
                .build();
            // send request / receive response in the form of a String
            HttpResponse<String> response = HTTP_CLIENT
                .send(request, BodyHandlers.ofString());
            // ensure the request is okay
            if (response.statusCode() != 200) {
                throw new IOException(response.toString());
            } // if
            // get request body (the content we requested), as a string
            String jsonString = response.body();
            //parse the JSON-formatted string using GSON
            PokeResponse pokeResponse = GSON
                .fromJson(jsonString, PokeResponse.class);

            pokemonName = randomPokemon(pokeResponse);

        } catch (IOException | InterruptedException e) {
            System.err.println(e);
            e.printStackTrace();
        } // trycatch
    } //pictureGet

    /** Returns the name of a random pokemon from the first 20 returned from the query.
     * @param pokeResponse is the response from url
     * @return name of a random pokemon using pokeResponse
     */
    public static String randomPokemon(PokeResponse pokeResponse) {
        String[] nameArray = new String[20];

        for (int i = 0; i < nameArray.length; i++) {
            nameArray[i] = pokeResponse.pokemonSpecies[i].name;
        } // for
        Random rand  = new Random();
        int random = rand.nextInt(19);
        return nameArray[random];
    } //imgCraft

/** This method returns the string of the name so it's usable outside
 * this class.
 * @param date needs to be passed here to interact with application class.
 * @return string of the pokemon name
 * @param  getApod discerns whether this is used to make an APOD image.
 */
    public static String getName(String date, boolean getApod) {
        pictureGet(date, getApod);
        return pokemonName;
    } // getName

} //PokeApi
