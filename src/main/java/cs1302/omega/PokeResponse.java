package cs1302.omega;

import cs1302.omega.PokeResult;
import com.google.gson.annotations.SerializedName;

/**
 * This class represents a response from the PokeApi, and is used by GSON to
 * create a java object.
 */
public class PokeResponse {

    @SerializedName("pokemon_species")
    public PokeResult[] pokemonSpecies;

} //PokeResponse
